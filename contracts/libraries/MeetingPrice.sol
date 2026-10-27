// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

// The sqrtPriceX96 where two pools' prices meet, sized from each pool's marginal
// price and liquidity rather than virtual reserves (which blow up at an extreme
// tick). Restoring a dislocated pool to this point, instead of all the way to the
// other pool's current price, is the profit-maximizing target: it accounts for the
// other pool moving as it absorbs the trade, so a shallow other pool is not
// overshot into a loss and a deep one still pulls a near-full restore.
//
// Without fees, the restore shuttles one token from the dislocated pool to the other,
// and which token depends on the direction, so the meeting price has two exact closed
// forms under a local-constant-liquidity linearization (the same within-tick assumption
// the pool's own swap uses between initialized ticks):
//   down-restore (sd >= sa, token1 shuttled): arithmetic mean of sqrt prices
//       T = (ld*sd + la*sa) / (ld + la)
//   up-restore   (sd <  sa, token0 shuttled): harmonic mean of sqrt prices
//       T = (ld + la) / (ld/sd + la/sa) = sd*sa / ((ld*sa + la*sd)/(ld + la))
// Both lie in [min(sd,sa), max(sd,sa)], give or take a <=2-wei floor artifact on
// the up-restore high side (economically nil, and still on the correct side of the
// current price, which is what the swap limit needs). target() computes them.
//
// VanHelsing sizes with the fee-aware optimum instead, where the two pools settle a fee
// wedge apart: noArb() first, then meetAt(). target() and targetFee() are the reference
// forms its tests check against.
library MeetingPrice {
    // sd, sa: the two pools' sqrtPriceX96 (same token0/token1 orientation).
    // ld, la: their liquidity in V3 units (for a V2 pool, sqrt(r0*r1)).
    //
    // la is the second pool's in-range liquidity, a proxy for its depth. When it is 0
    // its tick sits in a gap and the proxy is meaningless (depth may be one tick
    // away), so fall back to its price (a full restore, whose sale into it crosses
    // the gap into real liquidity) rather than reading zero capacity and declining to
    // defend. Returns sd only when neither pool has any liquidity, so
    // the caller reads an unchanged price as "no arb".
    function target(uint160 sd, uint256 ld, uint160 sa, uint256 la) internal pure returns (uint160) {
        uint256 lsum = ld + la;
        if (lsum == 0) return sd;
        if (la == 0) return sa;
        if (sd >= sa) {
            // arithmetic mean; each floored term <= max(sd,sa), the sum <= it too,
            // so the uint160 cast never truncates a valid sqrt price.
            return uint160(FixedPointMathLib.fullMulDiv(ld, sd, lsum) + FixedPointMathLib.fullMulDiv(la, sa, lsum));
        }
        // harmonic mean, kept overflow-safe: w is the cross-weighted average in
        // [sd, sa], then T = sd*sa / w lands back in [sd, sa] (fullMulDiv carries
        // the 512-bit sd*sa product, so no intermediate overflows). w > 0 for any
        // valid sqrt price (sd, sa >= MIN_SQRT_RATIO), and sd here is the first pool's
        // live sqrtPrice, so the divide never hits zero.
        uint256 w = FixedPointMathLib.fullMulDiv(ld, sa, lsum) + FixedPointMathLib.fullMulDiv(la, sd, lsum);
        return uint160(FixedPointMathLib.fullMulDiv(sd, sa, w));
    }

    // Fixed-point scales for the fee-aware target: G = P*gamma = P/sqrt((nd/dd)(na/da)), and
    // P2 scales the up-restore reciprocal sum.
    uint256 private constant P = 1 << 64;
    uint256 private constant P2 = 1 << 96;

    // Clamp a computed final into [min(sd,sa), max(sd,sa)]. The gamma wedge pushes a
    // final OUTSIDE the two live prices exactly when the dislocation is smaller than
    // the round-trip fee: no profitable arb exists there, and a target past the
    // driven pool's own price is a doomed drive. Pinned to the interval edge, the
    // caller reads target == cur and no-ops via its NO_ARB guard. Both live prices
    // are valid uint160 sqrt prices, so this also keeps the cast in range.
    function _clampIv(uint256 x, uint160 sd, uint160 sa) private pure returns (uint160) {
        (uint160 lo, uint160 hi) = sd < sa ? (sd, sa) : (sa, sd);
        if (x < lo) return lo;
        if (x > hi) return hi;
        return uint160(x);
    }

    // The fee-aware meeting: the two prices where the pools settle at the exact
    // two-pool optimum, gamma = 1/sqrt((nd/dd)(na/da)) apart (not equal, as the
    // fee-free target() leaves them). Each pool is (sqrtPrice s, liquidity l, fee
    // multiplier n/d = 1 - fee). Returns BOTH final prices so the caller can drive
    // either pool to its own final price:
    //   sdFinal = the (sd,ld,nd,dd) pool's final price,
    //   saFinal = the (sa,la,na,da) pool's final price.
    // Down (sd >= sa): sdFinal = gamma*saFinal; the arithmetic intermediate saf IS
    // saFinal, so it comes for free. Up (sd < sa): saFinal = gamma*sdFinal. Both
    // relations were checked against a brute-force profit maximizer, and hold only
    // when both finals land inside the interval. The interval clamp (_clampIv) pins each
    // final INDEPENDENTLY into [min(sd,sa), max(sd,sa)], so a sub-fee draw can pin one
    // side to its own live price while the other keeps its raw, unrelated value, breaking
    // the exact gamma ratio between them (see test/meeting-price-fee.test.js's fuzz test,
    // which detects pinning from the outputs and skips the ratio check there).
    //
    // With fee terms under 2^54 (wedge2) and liquidity under 2^128, the products fit a
    // uint256 for any real fee and price, the L*s ones only inside fullMulDiv's 512-bit
    // intermediate; past that, checked arithmetic reverts, a no-op for the ward. la == 0
    // (the second pool's tick in a gap) falls back to its price, as in the fee-free target.
    function meet(
        uint160 sd,
        uint256 ld,
        uint256 nd,
        uint256 dd,
        uint160 sa,
        uint256 la,
        uint256 na,
        uint256 da
    ) internal pure returns (uint160 sdFinal, uint160 saFinal) {
        if (la == 0) return (ld == 0 ? sd : sa, sa); // passthrough of live prices, already valid
        // G = P*gamma = sqrt(P^2 * dd*da / (nd*na)), held in nd, which it replaces (the stack
        // has no room for one more). Reverts (a swallowed no-op) only for a ~100% fee pool.
        nd = FixedPointMathLib.sqrt(wedge2(nd, dd, na, da));
        return meetAt(sd, ld, sa, la, na, da, nd);
    }

    // meet, with G = P*gamma, the root of wedge2, worked out by the caller. It is the same for
    // the two pools in either order, so a caller that meets them more than once works it out
    // once; the first pool's fee then enters only through it.
    function meetAt(uint160 sd, uint256 ld, uint160 sa, uint256 la, uint256 na, uint256 da, uint256 G)
        internal
        pure
        returns (uint160 sdFinal, uint160 saFinal)
    {
        if (la == 0) return (ld == 0 ? sd : sa, sa); // passthrough of live prices, already valid
        uint256 DenS = P * da * la + na * G * ld;
        if (sd >= sa) {
            uint256 saf = FixedPointMathLib.fullMulDiv(P * na * ld, sd, DenS)
                + FixedPointMathLib.fullMulDiv(P * da * la, sa, DenS);
            // sdFinal = gamma*saf exits [sa, sd] on a sub-fee dislocation; pin it.
            return (_clampIv(FixedPointMathLib.fullMulDiv(G, saf, P), sd, sa), _clampIv(saf, sd, sa));
        }
        uint256 u = FixedPointMathLib.fullMulDiv(P2, la, sa)
            + FixedPointMathLib.fullMulDiv(P2 * na, ld, da * sd);
        sdFinal = _clampIv(FixedPointMathLib.fullMulDiv(DenS, P2, G * da * u), sd, sa);
        saFinal = _clampIv(FixedPointMathLib.fullMulDiv(sdFinal, G, P), sd, sa); // gamma * sdFinal
    }

    // True when the two pools' sqrt-price ratio is within the round-trip fee wedge
    // gamma = 1/sqrt((nd/dd)(na/da)): no restore can gross more than the round trip pays
    // in fees, so its profit is <= 0 for any liquidity and either drive direction, and
    // the caller can no-op WITHOUT walking depth. Liquidity-independent: the pre-check of
    // exactly the interval clamp `meet` applies. It compares the P-scaled price ratio x with
    // G = P*gamma, meet's own value, so the wedge cannot drift from the sizing, but squared:
    // x <= floor(sqrt(wedge2)) exactly when x*x <= wedge2, and x >= 2^128 is past any root of
    // a uint256. Overflow-safe: max*P <= 2^160*2^64 fits uint256. A zero fee-numerator (a
    // degenerate ~100% fee) makes nd*na == 0 and REVERTS the divide rather than returning:
    // a swallowed no-op upstream (as `meet` reverts there too), never a missed check that
    // costs funds.
    function noArb(uint160 sd, uint256 nd, uint256 dd, uint160 sa, uint256 na, uint256 da) internal pure returns (bool) {
        uint256 z = wedge2(nd, dd, na, da);
        (uint160 lo, uint160 hi) = sd < sa ? (sd, sa) : (sa, sd);
        uint256 x = (uint256(hi) << 64) / lo;
        return x < 1 << 128 && x * x <= z;
    }

    // P^2 * dd*da / (nd*na), the round-trip fee wedge squared and P-scaled: G = P*gamma is its
    // root. Each fee term stays under 2^54 (a route's is two hops' product, and a transfer tax
    // folds in 1e4 more), so dd*da << 128 fits.
    function wedge2(uint256 nd, uint256 dd, uint256 na, uint256 da) internal pure returns (uint256) {
        return (dd * da << 128) / (nd * na);
    }

    // Just the first pool's final price: the swap-to-limit target when that pool is the
    // one driven.
    function targetFee(uint160 sd, uint256 ld, uint256 nd, uint256 dd, uint160 sa, uint256 la, uint256 na, uint256 da)
        internal
        pure
        returns (uint160 sdFinal)
    {
        (sdFinal,) = meet(sd, ld, nd, dd, sa, la, na, da);
    }
}
