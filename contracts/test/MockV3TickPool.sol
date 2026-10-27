// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

// A Uniswap V3-shaped pool with a sculptable tick distribution, for exercising V3Depth: it
// exposes slot0's tick, tickSpacing, ticks(liquidityNet) and a faithful tickBitmap, so a test
// can build a pool whose active tick is thin while an adjacent tick is deep, a distribution a
// real forked pool cannot be made to hold. View only: depth reads never swap.
contract MockV3TickPool {
    uint160 private _sqrtPriceX96;
    int24 private _tick;
    uint128 public liquidity; // spot active-tick liquidity, as UniswapV3Pool.liquidity()
    int24 public immutable tickSpacing;
    // RouteLib._hopVR reads these to sort the hop's (near,far) tokens against the
    // pool's own tok0/tok1; the caller must pass them in ascending order, as a real
    // V3 pool would report (this mock does not enforce or use the ordering itself).
    address public immutable token0;
    address public immutable token1;

    mapping(int16 => uint256) private _bitmap;
    mapping(int24 => int128) private _net;

    constructor(
        uint160 sqrtPriceX96,
        int24 currentTick,
        uint128 spotLiquidity,
        int24 spacing,
        address token0_,
        address token1_
    ) {
        _sqrtPriceX96 = sqrtPriceX96;
        _tick = currentTick;
        liquidity = spotLiquidity;
        tickSpacing = spacing;
        token0 = token0_;
        token1 = token1_;
    }

    // Initialize `t` with its net liquidity delta (crossing it while the price rises
    // adds liquidityNet, while it falls subtracts it) and mark it in the bitmap.
    function setTick(int24 t, int128 net) external {
        require(t % tickSpacing == 0, "SPACING");
        _net[t] = net;
        (int16 wordPos, uint8 bitPos) = _position(t / tickSpacing);
        _bitmap[wordPos] |= uint256(1) << bitPos;
    }

    // Truncated to the leading fields V3Depth reads; a real pool returns more, which the
    // caller's two-field read ignores.
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick) {
        return (_sqrtPriceX96, _tick);
    }

    function ticks(int24 t) external view returns (uint128 liquidityGross, int128 liquidityNet) {
        return (0, _net[t]);
    }

    function tickBitmap(int16 wordPosition) external view returns (uint256) {
        return _bitmap[wordPosition];
    }

    // TickBitmap.position on the spacing-compressed tick, as in Uniswap v4-core (Copyright 2023
    // Universal Navigation Inc., MIT License).
    function _position(int24 compressed) private pure returns (int16 wordPos, uint8 bitPos) {
        wordPos = int16(compressed >> 8);
        bitPos = uint8(int8(compressed % 256));
    }
}
