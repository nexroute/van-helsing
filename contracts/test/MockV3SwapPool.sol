// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// A Uniswap V3-shaped pool that really swaps, over one full-range position of constant
// liquidity (no initialized ticks, so V3Depth reads its spot liquidity). It keeps V3's
// interface and its two rules that matter to VanHelsing: the output is sent first and
// the input is collected in the swap callback, and the pool then checks its own balance
// grew by the input ("IIA"), so a payer whose token taxes the transfer has to send more.
// The fee is taken on the input (pips over 1e6) and every rounding favors the pool.
contract MockV3SwapPool {
    uint256 private constant Q96 = 1 << 96;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public constant tickSpacing = 60;
    uint128 public immutable liquidity;
    uint160 private sqrtP;
    int24 private tick;

    constructor(address t0, address t1, uint24 fee_, uint160 sqrtPriceX96, int24 tick_, uint128 liquidity_) {
        require(t0 < t1, "SORT");
        token0 = t0;
        token1 = t1;
        fee = fee_;
        sqrtP = sqrtPriceX96;
        tick = tick_;
        liquidity = liquidity_;
    }

    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick_) {
        return (sqrtP, tick);
    }

    function ticks(int24) external pure returns (uint128, int128) {
        return (0, 0);
    }

    function tickBitmap(int16) external pure returns (uint256) {
        return 0;
    }

    // amountSpecified > 0 is exact input, < 0 exact output, as in UniswapV3Pool.
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified != 0, "AS");
        require(zeroForOne ? limit < sqrtP : limit > sqrtP, "SPL");
        (uint256 amtIn, uint256 amtOut, uint160 next) = amountSpecified > 0
            ? _exactIn(zeroForOne, uint256(amountSpecified), limit)
            : _exactOut(zeroForOne, uint256(-amountSpecified), limit);
        sqrtP = next;
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(amtOut)) : (-int256(amtOut), int256(amtIn));
        if (amtOut > 0) IERC20Bal(tOut).transfer(recipient, amtOut);
        uint256 before = IERC20Bal(tIn).balanceOf(address(this));
        IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20Bal(tIn).balanceOf(address(this)) >= before + amtIn, "IIA");
    }

    // Spend up to `gross` (fee included), stopping at the price limit.
    function _exactIn(bool zfo, uint256 gross, uint160 limit) private view returns (uint256 amtIn, uint256 amtOut, uint160 next) {
        uint256 net = FixedPointMathLib.fullMulDiv(gross, 1e6 - fee, 1e6);
        uint256 toLimit = zfo ? _delta0(limit, sqrtP, true) : _delta1(sqrtP, limit, true);
        if (net >= toLimit) {
            next = limit;
            amtIn = toLimit + FixedPointMathLib.fullMulDivUp(toLimit, fee, 1e6 - fee);
        } else {
            next = zfo
                ? uint160(FixedPointMathLib.fullMulDivUp(uint256(liquidity) << 96, sqrtP, (uint256(liquidity) << 96) + net * sqrtP))
                : uint160(sqrtP + FixedPointMathLib.fullMulDiv(net, Q96, liquidity));
            amtIn = gross;
        }
        amtOut = zfo ? _delta1(next, sqrtP, false) : _delta0(sqrtP, next, false);
    }

    // Buy exactly `out`, which must not push the price past the limit.
    function _exactOut(bool zfo, uint256 out, uint160 limit) private view returns (uint256 amtIn, uint256 amtOut, uint160 next) {
        if (zfo) {
            next = uint160(sqrtP - FixedPointMathLib.fullMulDivUp(out, Q96, liquidity));
            require(next > limit, "LIMIT");
            amtIn = _delta0(next, sqrtP, true);
        } else {
            uint256 l96 = uint256(liquidity) << 96;
            next = uint160(FixedPointMathLib.fullMulDivUp(l96, sqrtP, l96 - out * sqrtP));
            require(next < limit, "LIMIT");
            amtIn = _delta1(sqrtP, next, true);
        }
        amtIn += FixedPointMathLib.fullMulDivUp(amtIn, fee, 1e6 - fee);
        amtOut = out;
    }

    // token0 between sqrt prices a < b: L * (b - a) / (a * b), scaled by 2^96.
    function _delta0(uint160 a, uint160 b, bool up) private view returns (uint256) {
        uint256 l96 = uint256(liquidity) << 96;
        return up
            ? FixedPointMathLib.fullMulDivUp(FixedPointMathLib.fullMulDivUp(l96, b - a, b), 1, a)
            : FixedPointMathLib.fullMulDiv(l96, b - a, b) / a;
    }

    // token1 between sqrt prices a < b: L * (b - a) / 2^96.
    function _delta1(uint160 a, uint160 b, bool up) private view returns (uint256) {
        return up ? FixedPointMathLib.fullMulDivUp(liquidity, b - a, Q96) : FixedPointMathLib.fullMulDiv(liquidity, b - a, Q96);
    }
}
