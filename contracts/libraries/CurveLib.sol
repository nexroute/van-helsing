// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { Chain } from "./Chain.sol";

interface ICurvePool {
    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256); // CURVE
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external; // CURVE
}

interface IStableSwapPool {
    function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256); // PancakeStableSwap
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external; // PancakeStableSwap
}

// A Rialto market, on Robinhood Chain: what VanHelsing calls of it.
interface IRialtoMarket {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function traderVault() external view returns (address);
    function getAmountOut(bool zeroForOne, uint256 amountIn) external view returns (uint256);
    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline)
        external
        payable
        returns (uint256);
}

// Tessera's entry, on Robinhood Chain: one contract that prices every pair, paying out of one
// treasury (Chain.TESSERA_TREASURY). A positive amountSpecified is an exact input.
interface ITessera {
    function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
        external
        view
        returns (uint256 amountIn, uint256 amountOut);
    function tesseraSwapWithAllowances(
        address tokenIn,
        address tokenOut,
        int256 amountSpecified,
        uint256 amountCheck,
        address recipient,
        bytes calldata swapData
    ) external;
}

using SafeTransferLib for address;

// Minimal adapter for the venues a ward can only sink into: the two Curve-style kinds on BNB
// Chain, CURVE (int128 exchange) and PancakeStableSwap (uint256 exchange), each a 2-coin pool
// holding exactly the pair's two tokens, and the market makers of Robinhood Chain, Rialto
// (RIALTO) and Tessera (TESSERA). All are pre-funded via allowance, with no output-first (flash)
// mode, so such a venue can only ever be a SINK here, never the driven pool: VanHelsing is
// fundless and the driven pool must hand over its output first. See V2Lib and V3Lib for the
// flash-capable protocols.
//
// A market maker is priced by an oracle and pays out of an inventory it keeps apart: a Rialto
// market's vault, which the venue's markets share (traderVault), or Tessera's one treasury,
// behind one entry that prices every pair. A Rialto quote is a step function of size, a
// half-spread chosen by the trade's size and charged on the whole trade, so a bigger input can
// buy less. A market is priced here by its own quotes, never by a copy of its formula, and a
// restore into it is capped at the size it was quoted at (marketPrice, depth).
//
// price(), depth() and sink() are PUBLIC, so this library is deployed separately and
// linked: VanHelsing delegatecalls it rather than inlining its bytecode. Only a ward with a
// stableswap leg pays the delegatecall overhead, and keeping this bytecode out of VanHelsing
// keeps VanHelsing under the 24576-byte limit.
//
// depth() is a near-peg TANGENT fit: accurate near the peg (an amplified pool's depth
// there is many times the constant-product proxy's), but it OVER-states what the pool
// can PAY once a restore pushes it toward saturation. depth() therefore caps it by what
// the pool can pay over the restore's price range, which is known there.
library CurveLib {
    uint8 internal constant KIND_CURVE = 5;
    uint8 internal constant KIND_RIALTO = 11;
    uint8 internal constant KIND_TESSERA = 25;

    // A market's reference size, per input token: a thousandth of what its vault holds of it.
    uint256 private constant MARKET_SHARE = 1000;

    // The balances of (t0, the pair's other token), mapped through coins(0): the tests' view
    // of _book, which the library's own reads go through.
    function balances(address pool, address t0) internal view returns (uint256 b0, uint256 b1) {
        (b0, b1,) = _book(pool, t0);
    }

    // The balances of (t0, the other coin) and t0's coin index, through one coins(0).
    function _book(address pool, address t0) private view returns (uint256 b0, uint256 b1, uint256 i) {
        i = ICurvePool(pool).coins(0) == t0 ? 0 : 1;
        (b0, b1) = (ICurvePool(pool).balances(i), ICurvePool(pool).balances(1 - i));
    }

    // Price a stableswap: the sqrtPriceX96 of a balance-scaled get_dy unit quote
    // (min(1e18, b0/1000)), not the balances ratio: a stableswap stays near peg while its
    // balances are imbalanced, so pricing off balances would invent a phantom dislocation
    // (get_dy is A-aware), and a FIXED 1e18 probe would read phantom prices on pools smaller
    // than the probe. Saturates at the top of uint160; VanHelsing clamps it to the tick
    // bounds.
    function price(uint8 kind, address pool, address t0) public view returns (uint160 s) {
        (uint256 b0, uint256 b1, uint256 i) = _book(pool, t0);
        require(b0 > 0 && b1 > 0, "POOL_EMPTY");
        uint256 dxU = b0 / 1000;
        if (dxU > 1e18) dxU = 1e18;
        uint256 dyU = dxU == 0 ? 0 : _quote(kind, pool, i, 1 - i, dxU);
        require(dyU > 0, "POOL_DUST"); // unquotable dust: refuse rather than invent a price
        uint256 s0 = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(dyU, 1 << 192, dxU));
        s = s0 > type(uint160).max ? type(uint160).max : uint160(s0);
    }

    // A stableswap's depth for sizing a restore that moves its price from sOwn toward the
    // other leg's sOther: a near-peg tangent fit from a b0/100 reference trade (ten times
    // price()'s unit quote at least, so the impact it measures is never the quote's own), the
    // constant-product proxy when the impact is too small to measure, then capped by what the
    // pool can pay over the move. Only sizing needs it, so a ward that stops at the fee check
    // never quotes it.
    //
    // The cap. The tangent L is honest near the peg but over-states what the pool can PAY
    // once a restore pushes it toward saturation: no slope-only L can encode the curve's
    // hard capacity bound (output can never exceed the opposite-side balance). The bound
    // lives here instead, where the restore's price interval is known: a stableswap is
    // always the sink (no flash mode) and the meeting target stays inside
    // [min(sOwn, sOther), max(sOwn, sOther)], so the stable's price moves at most from its own
    // live price sOwn to the other leg's sOther. Cap L so the LINEAR model's
    // implied output over that whole move cannot exceed HALF the output-side
    // balance (a rising price pays token0: amt0 = L*(hi-lo)*2^96/(hi*lo); a
    // falling one pays token1: amt1 = L*(hi-lo)/2^96; the half is a haircut that
    // keeps the target in the honestly-payable region, since the real curve pays
    // less than the linear model near depletion). The cap scales as
    // balance/interval-width: astronomically large at small dislocations (never
    // binds near peg), binding exactly on the ratio-extreme points where the
    // tangent over-promises. Skipped for sOwn == sOther (the meeting no-ops there anyway).
    //
    // `cap` itself can floor to 0 (integer division): the falling branch floors whenever
    // (b1 / 2) * 2^96 is below sOwn - sOther (an output-side balance small relative to the
    // restore interval), and the rising branch's inner `fullMulDiv(sOther, sOwn, 1 << 96)`
    // floors whenever the two prices' product undercuts 2^96, which is reachable on a
    // grotesque-but-registered pool (extreme balance skew or extreme price
    // magnitudes), not something POOL_DUST rules out (that check only bounds b0
    // >= ~1000 and the unit quote, never b1 or either price's magnitude). A 0 cap
    // is not merely "no capacity": fed into the meeting price (MeetingPrice.meetAt) as a
    // zero liquidity, it hits that library's tick-in-a-gap passthrough and reads as
    // an INFINITELY deep sink, driving a full restore into a pool that in fact can
    // pay almost nothing: the cap would invert its own purpose. Flooring to 1 wei
    // instead keeps the sign of "bind hard" without the inversion: a 1-wei L reads
    // as a near-zero-capacity sink, so the sized drive rounds to ~0 and the ward
    // dies cleanly at NO_ARB or BELOW_FLOOR rather than overshooting.
    function depth(uint8 kind, address pool, address t0, address t1, uint160 sOwn, uint160 sOther)
        public
        view
        returns (uint256 l)
    {
        if (kind == KIND_RIALTO || kind == KIND_TESSERA) return _marketDepth(kind, pool, t0, t1, sOwn, sOther);
        (uint256 b0, uint256 b1, uint256 i) = _book(pool, t0);
        l = _depth(kind, pool, i, 1 - i, b0 / 100, sOwn);
        if (l == 0) l = FixedPointMathLib.sqrt(b0 * b1);
        if (sOwn == sOther) return l;
        uint256 cap = sOther > sOwn
            ? FixedPointMathLib.fullMulDiv(b0 / 2, FixedPointMathLib.fullMulDiv(sOther, sOwn, 1 << 96), sOther - sOwn)
            : FixedPointMathLib.fullMulDiv(b1 / 2, 1 << 96, sOwn - sOther);
        if (cap == 0) cap = 1;
        return l < cap ? l : cap;
    }

    // Effective constant-L depth from a get_dy price impact. For the (sqrtP, L) model a
    // swap of refDx satisfies refDx * s0 * s1 = dy * 2^192 (fee-inclusive on both sides,
    // so the fee cancels to first order), so s1 = dy*2^192/(refDx*s0) and the depth is
    // L = dy * 2^96 / (s0 - s1). Exact integer math: the small (s0 - s1) is a large
    // exact integer, not a lossy float subtraction.
    function _depth(uint8 kind, address pool, uint256 i, uint256 j, uint256 refDx, uint160 s0)
        private
        view
        returns (uint256)
    {
        if (refDx == 0) return 0;
        uint256 dy = _quote(kind, pool, i, j, refDx);
        uint256 s1 = FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(dy, 1 << 96, refDx), 1 << 96, s0);
        if (s1 == 0 || s1 >= s0) return 0; // no measurable impact / wrong direction
        return FixedPointMathLib.fullMulDiv(dy, 1 << 96, s0 - s1);
    }

    function _quote(uint8 kind, address pool, uint256 i, uint256 j, uint256 dx) private view returns (uint256) {
        if (kind == KIND_CURVE) {
            return ICurvePool(pool).get_dy(int128(int256(i)), int128(int256(j)), dx);
        }
        return IStableSwapPool(pool).get_dy(i, j, dx);
    }

    // Sink `amountIn` of tokenIn into the pool (exact-in), output to this contract.
    // Pre-funded: approve, then exchange. min_dy is 0: the fundless round trip
    // reverts on the repay if the output is short, which is the real slippage guard.
    // `kind` selects the exchange signature (CURVE int128 vs PancakeStableSwap uint256).
    function sink(uint8 kind, address pool, address tokenIn, address tokenOut, uint256 amountIn) public {
        if (kind == KIND_RIALTO || kind == KIND_TESSERA) {
            // The market pulls the input with an allowance scoped to this swap, closed after: the
            // markets are upgradeable proxies, and an allowance left standing would be a standing
            // claim on whatever VanHelsing ever holds.
            tokenIn.safeApproveWithRetry(pool, amountIn);
            if (kind == KIND_RIALTO) {
                IRialtoMarket(pool).swapExactIn(IRialtoMarket(pool).token0() == tokenIn, amountIn, 0, address(this), 0);
            } else {
                ITessera(pool).tesseraSwapWithAllowances(tokenIn, tokenOut, int256(amountIn), 1, address(this), "");
            }
            tokenIn.safeApprove(pool, 0);
            return;
        }
        uint256 i;
        uint256 j;
        if (ICurvePool(pool).coins(0) == tokenIn) {
            (i, j) = (0, 1);
        } else {
            (i, j) = (1, 0);
        }
        tokenIn.safeApproveWithRetry(pool, amountIn);
        if (kind == KIND_CURVE) {
            ICurvePool(pool).exchange(int128(int256(i)), int128(int256(j)), amountIn, 0);
        } else {
            IStableSwapPool(pool).exchange(i, j, amountIn, 0);
        }
    }

    // A market's leg: its bid, from selling the reference size of t0, and its ask, from buying t0
    // with the reference size of t1, both from the market's own quotes, so the spread and any
    // charge it adds for recent flow are its own. The mid is their geometric mean, and
    // sqrt(bid / ask) the fee multiplier fn / fd that turns the mid back into the bid on a sale and
    // the ask on a purchase. A Rialto half-spread only steps up with size, so these are the worst
    // prices of any trade up to the reference size, which depth() caps a restore at. A market that
    // refuses to quote is no anchor.
    function marketPrice(uint8 kind, address venue, address t0, address t1)
        public
        view
        returns (uint160 s, uint256 fn, uint256 fd)
    {
        (uint256 q0, uint256 q1,,) = _stock(kind, venue, t0, t1);
        uint256 out1 = _quote(kind, venue, t0, t1, q0);
        uint256 out0 = _quote(kind, venue, t1, t0, q1);
        require(out1 != 0 && out0 != 0, "REFUSED");
        uint256 sBid = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(out1, 1 << 192, q0));
        uint256 sAsk = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(q1, 1 << 192, out0));
        uint256 mid = FixedPointMathLib.sqrt(sBid) * FixedPointMathLib.sqrt(sAsk);
        s = mid > type(uint160).max ? type(uint160).max : uint160(mid);
        fd = 1e10;
        fn = sBid >= sAsk ? fd : FixedPointMathLib.fullMulDiv(sBid, fd, sAsk);
    }

    // A market's depth for a restore that moves its price from sOwn toward sOther. Its quote is flat
    // up to the reference size, so it has no depth of its own to fit, only two caps: the restore
    // takes no more input than the reference size it was priced at, and pays out no more than half
    // what its inventory holds of the output, as for a stableswap. A rising price takes t1 in and
    // pays t0 out, a falling one the reverse.
    function _marketDepth(uint8 kind, address venue, address t0, address t1, uint160 sOwn, uint160 sOther)
        private
        view
        returns (uint256 l)
    {
        if (sOwn == sOther) return 1; // nothing to restore: the meeting no-ops
        (uint256 q0, uint256 q1, uint256 b0, uint256 b1) = _stock(kind, venue, t0, t1);
        uint256 inCap;
        uint256 outCap;
        if (sOther > sOwn) {
            uint256 span = uint256(sOther) - sOwn;
            inCap = FixedPointMathLib.fullMulDiv(q1, 1 << 96, span);
            outCap = FixedPointMathLib.fullMulDiv(b0 / 2, FixedPointMathLib.fullMulDiv(sOther, sOwn, 1 << 96), span);
        } else {
            uint256 span = uint256(sOwn) - sOther;
            inCap = FixedPointMathLib.fullMulDiv(q0, FixedPointMathLib.fullMulDiv(sOwn, sOther, 1 << 96), span);
            outCap = FixedPointMathLib.fullMulDiv(b1 / 2, 1 << 96, span);
        }
        l = inCap < outCap ? inCap : outCap;
        if (l == 0) l = 1; // a zero would read as an infinitely deep sink (see depth)
    }

    // What a market would pay of tokenOut for exactly amountIn of tokenIn, by its own quote, or zero
    // when it refuses: a Rialto market answers zero itself; Tessera's entry answers for another
    // input than the one asked, and does not count its treasury, so its quote past what the
    // treasury holds is a refusal here.
    function _quote(uint8 kind, address venue, address tokenIn, address tokenOut, uint256 amountIn)
        private
        view
        returns (uint256)
    {
        if (amountIn == 0) return 0;
        if (kind == KIND_RIALTO) {
            return IRialtoMarket(venue).getAmountOut(IRialtoMarket(venue).token0() == tokenIn, amountIn);
        }
        (uint256 quotedIn, uint256 quotedOut) = ITessera(venue).tesseraSwapViewAmounts(tokenIn, tokenOut, int256(amountIn));
        if (quotedIn != amountIn || quotedOut > SafeTransferLib.balanceOf(tokenOut, Chain.TESSERA_TREASURY)) return 0;
        return quotedOut;
    }

    // A market's reference size and inventory of each token of the pair: what its vault (Rialto) or
    // treasury (Tessera) holds of it, and a thousandth of that.
    function _stock(uint8 kind, address venue, address t0, address t1)
        private
        view
        returns (uint256 q0, uint256 q1, uint256 b0, uint256 b1)
    {
        address inventory = kind == KIND_RIALTO ? IRialtoMarket(venue).traderVault() : Chain.TESSERA_TREASURY;
        b0 = SafeTransferLib.balanceOf(t0, inventory);
        b1 = SafeTransferLib.balanceOf(t1, inventory);
        (q0, q1) = (b0 / MARKET_SHARE, b1 / MARKET_SHARE);
    }
}
