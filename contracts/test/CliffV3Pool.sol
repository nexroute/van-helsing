// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// A Uniswap V3-shaped pool whose only position holds `liquidity` between two ticks: a pool whose
// liquidity ends near its price, as a dust or one-sided pool's does. Inside the range a swap trades
// at that liquidity; outside it nothing trades and the price runs on to the swap's limit, as a V3
// pool's does past the last position. Its slot0, liquidity, ticks and bitmap agree with the two
// bounds, so V3Depth walks it as it walks a real pool.
contract CliffV3Pool {
    uint256 private constant Q96 = 1 << 96;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 private immutable tickLower;
    int24 private immutable tickUpper;
    uint160 private immutable lo;
    uint160 private immutable hi;
    uint128 private immutable depth;
    uint160 private sqrtP;

    constructor(
        address t0,
        address t1,
        uint24 fee_,
        int24 spacing,
        uint160 sqrtPriceX96,
        uint128 liquidity_,
        int24 tickLower_,
        int24 tickUpper_
    ) {
        require(t0 < t1, "SORT");
        require(tickLower_ < tickUpper_ && tickLower_ % spacing == 0 && tickUpper_ % spacing == 0, "TICKS");
        (token0, token1, fee, tickSpacing) = (t0, t1, fee_, spacing);
        (tickLower, tickUpper, depth, sqrtP) = (tickLower_, tickUpper_, liquidity_, sqrtPriceX96);
        lo = TickMath.getSqrtPriceAtTick(tickLower_);
        hi = TickMath.getSqrtPriceAtTick(tickUpper_);
    }

    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick) {
        return (sqrtP, TickMath.getTickAtSqrtPrice(sqrtP));
    }

    function liquidity() external view returns (uint128) {
        return sqrtP >= lo && sqrtP < hi ? depth : 0;
    }

    function ticks(int24 t) external view returns (uint128 liquidityGross, int128 liquidityNet) {
        if (t == tickLower) return (depth, int128(depth));
        if (t == tickUpper) return (depth, -int128(depth));
        return (0, 0);
    }

    function tickBitmap(int16 wordPosition) external view returns (uint256 bits) {
        for (uint256 i; i < 2; i++) {
            int24 c = (i == 0 ? tickLower : tickUpper) / tickSpacing;
            if ((i == 0 ? tickLower : tickUpper) < 0 && (i == 0 ? tickLower : tickUpper) % tickSpacing != 0) c--;
            if (int16(c >> 8) == wordPosition) bits |= uint256(1) << uint8(int8(c % 256));
        }
    }

    // amountSpecified > 0 is exact input, < 0 exact output, as in UniswapV3Pool.
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified != 0, "AS");
        require(
            zeroForOne ? limit < sqrtP && limit > TickMath.MIN_SQRT_PRICE : limit > sqrtP && limit < TickMath.MAX_SQRT_PRICE,
            "SPL"
        );
        (uint256 amtIn, uint256 amtOut) = _move(zeroForOne, amountSpecified, limit);
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(amtOut)) : (-int256(amtOut), int256(amtIn));
        _settle(recipient, zeroForOne, amtIn, amtOut, amount0, amount1, data);
    }

    // Trade inside the stretch of the range the swap meets on its way, from where the price enters it
    // (across a gap, trading nothing) to where it leaves it, clipped at the limit; then the price
    // ends where the trade did, or, the range spent or never met, at the limit.
    function _move(bool zeroForOne, int256 amountSpecified, uint160 limit) private returns (uint256 amtIn, uint256 amtOut) {
        (uint160 from, uint160 to) = zeroForOne
            ? (sqrtP < hi ? sqrtP : hi, lo > limit ? lo : limit)
            : (sqrtP > lo ? sqrtP : lo, hi < limit ? hi : limit);
        uint160 next = limit;
        if (zeroForOne ? from > to : from < to) {
            sqrtP = from;
            bool filled;
            uint160 at;
            (amtIn, amtOut, at, filled) = amountSpecified > 0
                ? _exactIn(zeroForOne, uint256(amountSpecified), to)
                : _exactOut(zeroForOne, uint256(-amountSpecified), to);
            if (filled) next = at;
        }
        sqrtP = next;
    }

    // Send the output first, then collect the input in the callback, as a V3 pool does.
    function _settle(address recipient, bool zeroForOne, uint256 amtIn, uint256 amtOut, int256 amount0, int256 amount1, bytes calldata data)
        private
    {
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        if (amtOut > 0) IERC20Bal(tOut).transfer(recipient, amtOut);
        uint256 before = IERC20Bal(tIn).balanceOf(address(this));
        IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20Bal(tIn).balanceOf(address(this)) >= before + amtIn, "IIA");
    }

    // Spend up to `gross` (fee included) inside the range, which ends at `end`; filled when it is all
    // spent there.
    function _exactIn(bool zfo, uint256 gross, uint160 end)
        private
        view
        returns (uint256 amtIn, uint256 amtOut, uint160 next, bool filled)
    {
        uint256 net = FixedPointMathLib.fullMulDiv(gross, 1e6 - fee, 1e6);
        uint256 toEnd = zfo ? _delta0(end, sqrtP, true) : _delta1(sqrtP, end, true);
        if (net > toEnd) {
            next = end;
            amtIn = toEnd + FixedPointMathLib.fullMulDivUp(toEnd, fee, 1e6 - fee);
        } else {
            next = zfo
                ? uint160(FixedPointMathLib.fullMulDivUp(uint256(depth) << 96, sqrtP, (uint256(depth) << 96) + net * sqrtP))
                : uint160(sqrtP + FixedPointMathLib.fullMulDiv(net, Q96, depth));
            (amtIn, filled) = (gross, true);
        }
        amtOut = zfo ? _delta1(next, sqrtP, false) : _delta0(sqrtP, next, false);
    }

    // Buy up to `out` inside the range, which ends at `end`; filled when all of it is bought there.
    function _exactOut(bool zfo, uint256 out, uint160 end)
        private
        view
        returns (uint256 amtIn, uint256 amtOut, uint160 next, bool filled)
    {
        uint256 cap = zfo ? _delta1(end, sqrtP, false) : _delta0(sqrtP, end, false);
        if (out > cap) {
            (next, amtOut) = (end, cap);
        } else if (zfo) {
            next = uint160(sqrtP - FixedPointMathLib.fullMulDivUp(out, Q96, depth));
            (amtOut, filled) = (out, true);
        } else {
            uint256 l96 = uint256(depth) << 96;
            next = uint160(FixedPointMathLib.fullMulDivUp(l96, sqrtP, l96 - out * sqrtP));
            (amtOut, filled) = (out, true);
        }
        amtIn = zfo ? _delta0(next, sqrtP, true) : _delta1(sqrtP, next, true);
        amtIn += FixedPointMathLib.fullMulDivUp(amtIn, fee, 1e6 - fee);
    }

    // token0 between sqrt prices a < b: L * (b - a) / (a * b), scaled by 2^96.
    function _delta0(uint160 a, uint160 b, bool up) private view returns (uint256) {
        uint256 l96 = uint256(depth) << 96;
        return up
            ? FixedPointMathLib.fullMulDivUp(FixedPointMathLib.fullMulDivUp(l96, b - a, b), 1, a)
            : FixedPointMathLib.fullMulDiv(l96, b - a, b) / a;
    }

    // token1 between sqrt prices a < b: L * (b - a) / 2^96.
    function _delta1(uint160 a, uint160 b, bool up) private view returns (uint256) {
        return up ? FixedPointMathLib.fullMulDivUp(depth, b - a, Q96) : FixedPointMathLib.fullMulDiv(depth, b - a, Q96);
    }
}
