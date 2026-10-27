// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { IPoolRegistry } from "../interfaces/IPoolRegistry.sol";
import { RouteConfig } from "./RouteConfig.sol";
import { V2Lib } from "./V2Lib.sol";
import { V3Lib } from "./V3Lib.sol";
import { V3Depth } from "./V3Depth.sol";
import { V4Depth } from "./V4Depth.sol";
import { V4Config } from "./V4Config.sol";
import { UniV4Lib } from "./UniV4Lib.sol";
import { InfinityLib } from "./InfinityLib.sol";

interface IPoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

// VanHelsing's drive-callback context: what to sink and how to repay, threaded through
// the drive swap. Each sink hop's direction is its two tokens' ERC20 order (got -> owed for a
// direct sink, got -> mid -> owed for a route), which VanHelsing reads off the tokens.
// Declared at file level (not inside the contract) so RouteLib can build the route variant
// (cxRoute) without a circular type dependency; VanHelsing imports it.
struct Cx {
    address gotToken; // what the drive sent us; we sell it at the sink (hop 1 input)
    address owedToken; // what we owe the driven pool (the route's end token)
    uint256 owed; // V2 drive: the debt up front; any other drive: 0 (the swap's delta gives it)
    bytes32 sinkId; // first sink hop id (a pool contract's address, padded, or a singleton's poolId)
    uint8 sinkKind;
    uint32 sinkFee;
    bool exactOut; // direct sink: buy exactly owed. route hop 1: always false (exact-in)
    // second hop (routes only). sinkKind2 == NONE (255) means a direct 1-hop sink.
    bytes32 sinkId2;
    uint8 sinkKind2;
    uint32 sinkFee2;
    address mid; // the bridge token B (routes only)
    bool profitAtMid; // route: hop 2 buys exactly owed (profit stays in mid)
    uint16 sinkTaxIn; // transfer tax (bps) gotToken loses entering the first sink hop
}

// A 2-hop route (token0 -> mid -> token1) composed into one virtual constant-product
// pool. Two CP pools in series reduce exactly to a single CP pool with virtual reserves
//   V0 = A1*M2 / (M1 + M2),   V1 = B2*M1 / (M1 + M2)
// where hop1 holds (A1 = token0 reserve, M1 = mid reserve) and hop2 holds
// (M2 = mid reserve, B2 = token1 reserve). Each hop's reserves are its real reserves
// (V2) or the local virtual reserves of its concentrated tangent (r0 = L*2^96/s,
// r1 = L*s/2^96). The composite normalizes with the V2 mapping VanHelsing uses:
// s = sqrt(V1 * 2^192 / V0), L = sqrt(V0*V1), its fee multiplier the product of the hops'.
// Externally linked (public), so its bytecode does not count against VanHelsing's limit;
// the per-hop reads are inlined from the shared adapters.
library RouteLib {
    uint8 private constant V2 = 0;
    uint8 private constant V3 = 2;
    uint8 private constant UNIV4 = 4;
    uint8 private constant INFI = 6;
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q192 = 1 << 192;
    uint160 private constant MIN_SQRT = 4295128739 + 1;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    // Spot composite (sqrtPriceX96, liquidity, feeNum, feeDen) in the pair orientation.
    function normalize(IPoolRegistry reg, bytes32 routeId)
        public
        view
        returns (uint160 s, uint256 l, uint256 fn, uint256 fd)
    {
        return _compose(reg, routeId, 0, 0); // maxTicks 0 => spot L (no walk)
    }

    // Composite effective liquidity when the defended pool sits at defSqrtP: each
    // concentrated hop is walked toward a ratio-target (its own spot scaled by the full
    // composite move magnitude, in the direction the sink pushes it, within maxTicks;
    // see _hopTarget), then recomposed. V2 hops are constant-L. A hop whose liquidity is flat
    // over the walk reads the same however far it walks; one that deepens past its real move
    // reads deeper than it trades. The floor and the atomic revert backstop the mis-size.
    function effectiveLiquidity(IPoolRegistry reg, bytes32 routeId, uint160 defSqrtP, uint256 maxTicks)
        public
        view
        returns (uint256 l)
    {
        (, l,,) = _compose(reg, routeId, defSqrtP, maxTicks);
    }

    // Build VanHelsing's route sink context (cold path, linked externally so its bytecode
    // does not count against the contract's 24576-byte limit). got = zeroForOne ? t1 : t0;
    // the owed (end) token is the other pair token; mid is the bridge. Each hop's direction is
    // its two tokens' ERC20 order (UniV4Lib flips it for a native currency, as in a direct sink).
    function cxRoute(IPoolRegistry reg, bytes32 routeId, address t0, address t1, bool zeroForOne, bool profitAtMid)
        public
        view
        returns (Cx memory c)
    {
        c.gotToken = zeroForOne ? t1 : t0;
        c.owedToken = zeroForOne ? t0 : t1;
        c.mid = _mid(reg, routeId);
        (c.sinkId, c.sinkId2) = _hops(reg, routeId, c.gotToken == t0);
        c.profitAtMid = profitAtMid;
        _hopEntries(reg, c);
    }

    // Each hop's kind and fee from its own entry, and the tax gotToken loses entering the
    // first hop, stated on that hop's sorted side (IPoolRegistry.Pool.tax). Split out of
    // cxRoute to keep its stack within reach (no viaIR).
    function _hopEntries(IPoolRegistry reg, Cx memory c) private view {
        uint64 tax;
        (c.sinkKind,,, c.sinkFee, tax,) = reg.entryOf(c.sinkId);
        c.sinkTaxIn = uint16(tax >> (c.gotToken < c.mid ? 48 : 16));
        (c.sinkKind2,,, c.sinkFee2,,) = reg.entryOf(c.sinkId2);
    }

    // Route payout (cold path, linked externally): the profit lands in the bridge (mid) or
    // the end token (owed), never the start token (`got`), which hop 1 always spends in full.
    // The higher registry priority wins;
    // with no preference, or a tie, the second hop is exact-in and the profit lands at the end.
    // (Both hops are V2 or concentrated pools: sizing refuses a stableswap hop, _hopVR.)
    function payoutRoute(IPoolRegistry reg, bytes32 routeId, address t0, address t1, bool zeroForOne)
        public
        view
        returns (address base, bool profitAtMid, uint256 floor)
    {
        address end = zeroForOne ? t0 : t1;
        address mid = _mid(reg, routeId);
        (uint128 pm, uint128 fm, uint128 pe, uint128 fe) = reg.tokenInfos(mid, end);
        profitAtMid = pm > pe;
        (base, floor) = profitAtMid ? (mid, uint256(fm)) : (end, uint256(fe));
    }

    function _mid(IPoolRegistry reg, bytes32 routeId) private view returns (address) {
        return RouteConfig.mid(reg.configOf(routeId));
    }

    // (firstHopId, secondHopId) in execution order for the sink direction. hop1 connects
    // (t0, mid), hop2 connects (mid, t1); when got == t0 we traverse hop1 then hop2, when
    // got == t1 we traverse hop2 then hop1.
    function _hops(IPoolRegistry reg, bytes32 routeId, bool gotIsT0) private view returns (bytes32 first, bytes32 second) {
        bytes memory cfg = reg.configOf(routeId);
        bytes32 h1 = RouteConfig.hop1(cfg);
        bytes32 h2 = RouteConfig.hop2(cfg);
        return gotIsT0 ? (h1, h2) : (h2, h1);
    }

    // token0, token1 of the pair (from the route's entry), mid + hop ids (from config).
    struct Hops {
        address t0;
        address t1;
        address mid;
        bytes32 h1;
        bytes32 h2;
    }

    // One hop's resolved (reserveOfNear, reserveOfFar, feeNum, feeDen), packed so
    // _compose/_spotSqrt each carry one struct pointer per hop instead of four loose
    // uint256s, which keeps their stack footprint under the legacy codegen's 16-slot reach
    // (no viaIR; see _hop).
    struct HopR {
        uint256 near;
        uint256 far;
        uint256 fn;
        uint256 fd;
    }

    // A hop's sorted tokens and virtual reserves, for the same stack-depth reason as HopR:
    // _hop carries one pointer from _hopVR instead of four loose values.
    struct HopVR {
        address tok0;
        address tok1;
        uint256 r0;
        uint256 r1;
    }

    // The walk request threaded from _compose down through _hop into _hopVR: the sink
    // direction (up) and budget (maxTicks), plus the composite defended price and spot
    // needed to compute each hop's ratio-target (see _hopTarget). Bundled for the same
    // stack-depth reason as HopR/HopVR: _compose's two _hop calls carry one pointer
    // instead of four loose values each (no viaIR).
    struct Walk {
        uint256 maxTicks;
        bool up;
        uint160 defSqrtP;
        uint160 sSpot;
    }

    function _compose(IPoolRegistry reg, bytes32 routeId, uint160 defSqrtP, uint256 maxTicks)
        private
        view
        returns (uint160 s, uint256 l, uint256 fn, uint256 fd)
    {
        Hops memory h;
        {
            (, address t0, address t1,,, bool ok) = reg.entryOf(routeId);
            require(ok, "ROUTE_UNREG");
            bytes memory cfg = reg.configOf(routeId);
            h = Hops({ t0: t0, t1: t1, mid: RouteConfig.mid(cfg), h1: RouteConfig.hop1(cfg), h2: RouteConfig.hop2(cfg) });
        }

        // Per-hop: kind, fee, virtual reserves (sorted tok0<tok1), optional walk.
        // hop1 connects (t0, mid); hop2 connects (mid, t1). Direction of the sink move,
        // used only to pick each walk's ratio-target, comes from spot price vs defSqrtP.
        uint160 sSpot = maxTicks == 0 ? 0 : _spotSqrt(reg, h); // pair-space spot, for walk direction
        bool up = maxTicks != 0 && defSqrtP > sSpot; // restore raises the composite's t1/t0 price
        Walk memory w = Walk({ maxTicks: maxTicks, up: up, defSqrtP: defSqrtP, sSpot: sSpot });

        HopR memory r1 = _hop(reg, h.h1, h.t0, h.mid, w);
        HopR memory r2 = _hop(reg, h.h2, h.mid, h.t1, w);

        uint256 den = r1.far + r2.near;
        require(den > 0, "ROUTE_EMPTY");
        uint256 v0 = FixedPointMathLib.fullMulDiv(r1.near, r2.near, den);
        uint256 v1 = FixedPointMathLib.fullMulDiv(r2.far, r1.far, den);
        require(v0 > 0 && v1 > 0, "ROUTE_EMPTY");

        s = _clamp(FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(v1, Q192, v0)));
        l = FixedPointMathLib.sqrt(v0 * v1);
        if (l > type(uint128).max) l = type(uint128).max;
        fn = r1.fn * r2.fn;
        fd = r1.fd * r2.fd;
    }

    // Spot composite sqrtPrice only (for walk direction): a second read of both hops, the same
    // value normalize returned.
    // maxTicks == 0 skips the walk block in _hopVR, so the rest of the Walk is unused.
    function _spotSqrt(IPoolRegistry reg, Hops memory h) private view returns (uint160) {
        Walk memory w0; // maxTicks 0, up false, defSqrtP/sSpot 0 (all default zero values)
        HopR memory r1 = _hop(reg, h.h1, h.t0, h.mid, w0);
        HopR memory r2 = _hop(reg, h.h2, h.mid, h.t1, w0);
        uint256 den = r1.far + r2.near;
        if (den == 0) return MIN_SQRT;
        uint256 v0 = FixedPointMathLib.fullMulDiv(r1.near, r2.near, den);
        uint256 v1 = FixedPointMathLib.fullMulDiv(r2.far, r1.far, den);
        if (v0 == 0) return MIN_SQRT;
        return _clamp(FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(v1, Q192, v0)));
    }

    // Resolve one hop to (reserveOfNear, reserveOfFar, feeNum, feeDen), where `near`/`far`
    // are the two named tokens (near listed first). Walks a concentrated hop toward its
    // ratio-target when w.maxTicks>0 (`near` fixes the direction, w.defSqrtP/w.sSpot fix
    // the magnitude; see _hopVR/_hopTarget). Returns a struct (not a 4-tuple) so the
    // caller's stack only carries one pointer per hop (see HopR).
    function _hop(IPoolRegistry reg, bytes32 hopId, address near, address far, Walk memory w)
        private
        view
        returns (HopR memory r)
    {
        uint8 hk;
        {
            // scoped so hf/ok die before the _hopVR call (legacy codegen stack reach)
            uint32 hf;
            bool ok;
            (hk,,, hf,, ok) = reg.entryOf(hopId);
            require(ok, "STALE_HOP");
            (r.fn, r.fd) = _feeMul(hk, hf);
        }

        HopVR memory v = _hopVR(reg, hopId, hk, near, w);
        (r.near, r.far) = near == v.tok0 ? (v.r0, v.r1) : (v.r1, v.r0);
        // sanity: the hop must connect exactly {near, far}
        require((near == v.tok0 && far == v.tok1) || (near == v.tok1 && far == v.tok0), "ROUTE_MISWIRE");
    }

    // A hop's sorted tokens (tok0<tok1 by ERC20 address) and virtual reserves (r0,r1) in
    // that order. w.maxTicks>0 walks a concentrated hop's effective L toward a ratio-target
    // (see _hopTarget) in the direction the sink pushes it. w.up = the composite t1/t0
    // price rises, so the restore feeds t1 into hop2, mid from hop2 into hop1, and takes
    // t0 out of hop1: each hop RECEIVES its far token when up, its near token when down.
    // Feeding a pool its token1 raises its sqrtPrice (walk toward MAX), feeding token0
    // lowers it (walk toward MIN); both hops reduce to
    //   toMax = (near == tok0) ? w.up : !w.up
    // in the hop pool's own token sort (not the pair side the hop is on). w.defSqrtP/
    // w.sSpot are the composite defended price and composite spot (0/0 when w.maxTicks
    // == 0, the spot-normalize path where the walk block below never runs).
    function _hopVR(IPoolRegistry reg, bytes32 hopId, uint8 hk, address near, Walk memory w)
        private
        view
        returns (HopVR memory v)
    {
        if (hk == V2) {
            address pool = _addr(hopId);
            (v.r0, v.r1) = V2Lib.getReserves(pool);
            (v.tok0, v.tok1) = (IPoolTokens(pool).token0(), IPoolTokens(pool).token1());
        } else if (hk == V3) {
            address pool = _addr(hopId);
            uint160 sp = V3Lib.price(pool);
            (v.tok0, v.tok1) = (IPoolTokens(pool).token0(), IPoolTokens(pool).token1());
            uint256 lq = V3Lib.liquidity(pool);
            // per-hop target: the hop's own spot scaled by the FULL composite move magnitude,
            // applied in the hop's direction (toMax up, else down). Each hop moves less than the
            // composite (the composite ratio is the product of the two), so the walk covers more
            // than the hop's real range: like a direct sink's pass-1 read, it can count liquidity
            // the restore never reaches, and a route gets no second pass.
            if (w.maxTicks > 0) {
                bool toMax = (near == v.tok0) ? w.up : !w.up;
                uint160 tgt = _hopTarget(sp, w.defSqrtP, w.sSpot, toMax);
                (lq,) = V3Depth.effectiveLiquidity(pool, tgt, w.maxTicks);
            }
            (v.r0, v.r1) = _vr(sp, lq);
        } else if (hk == UNIV4 || hk == INFI) {
            bytes memory cfg = reg.configOf(hopId);
            (uint160 sp, uint256 lq) = hk == UNIV4
                ? (UniV4Lib.price(cfg), uint256(UniV4Lib.liquidity(cfg)))
                : (InfinityLib.price(cfg), uint256(InfinityLib.liquidity(cfg)));
            (v.tok0, v.tok1) = _sortErc20(V4Config.erc20(V4Config.currency0(cfg)), V4Config.erc20(V4Config.currency1(cfg)));
            if (w.maxTicks > 0) {
                bool toMax = (near == v.tok0) ? w.up : !w.up;
                uint160 tgt = _hopTarget(sp, w.defSqrtP, w.sSpot, toMax);
                (lq,) = V4Depth.effectiveLiquidity(hk, hopId, V4Config.tickSpacing(cfg), !V4Config.aligned(cfg), tgt, w.maxTicks);
            }
            (v.r0, v.r1) = _vr(sp, lq);
        } else {
            revert("ROUTE_HOP_KIND"); // stableswap/curve hops unsupported for sizing
        }
    }

    // sp scaled by the composite move magnitude (>=1), in the hop's direction.
    function _hopTarget(uint160 sp, uint160 defSqrtP, uint160 sSpot, bool toMax) private pure returns (uint160) {
        // move magnitude as a sqrt-price ratio >= 1: max(def/spot, spot/def)
        (uint256 hi, uint256 lo) = defSqrtP >= sSpot ? (uint256(defSqrtP), uint256(sSpot)) : (uint256(sSpot), uint256(defSqrtP));
        // a depth read must never revert: registry-garbage hi/lo could push fullMulDiv past
        // its 256-bit ceiling; that ratio would clamp to MAX_SQRT anyway, so saturate first.
        if (toMax && hi / lo > type(uint160).max / sp) return MAX_SQRT;
        uint256 t = toMax
            ? FixedPointMathLib.fullMulDiv(sp, hi, lo) // scale up
            : FixedPointMathLib.fullMulDiv(sp, lo, hi); // scale down, lo<=hi so result<=sp, cannot overflow
        return _clamp(t);
    }

    // Local virtual reserves of a concentrated pool at (sqrtPriceX96 s, liquidity L):
    // r0 = L*2^96/s, r1 = L*s/2^96 (r1/r0 == price == (s/2^96)^2).
    function _vr(uint160 s, uint256 lq) private pure returns (uint256 r0, uint256 r1) {
        r0 = FixedPointMathLib.fullMulDiv(lq, Q96, s);
        r1 = FixedPointMathLib.fullMulDiv(lq, s, Q96);
    }

    function _feeMul(uint8 kind, uint32 fee) private pure returns (uint256 num, uint256 den) {
        den = (kind == V3 || kind == UNIV4 || kind == INFI) ? 1e6 : 1e4;
        num = den - fee;
    }

    function _sortErc20(address a, address b) private pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _addr(bytes32 id) private pure returns (address) {
        return address(uint160(uint256(id)));
    }

    function _clamp(uint256 x) private pure returns (uint160) {
        if (x < MIN_SQRT) return MIN_SQRT;
        if (x > MAX_SQRT) return MAX_SQRT;
        return uint160(x);
    }
}
