// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

// Reproduces a single Uniswap-V3 / PancakeSwap-V3 swap on a specific pool, to recreate a
// front-run's exact price dislocation on a fork WITHOUT replaying the (guard-protected) MEV
// bot transaction. Fund this contract with the input token first (e.g. via setTokens), then
// call poke() with the amount + direction read from the front-run's on-chain Swap event.
//
// Also doubles as the calibration suite's pool-skew harness (test/*.test.js): the same
// poke() call front-runs a pool with an explicit amount + direction before a wei-exact
// capture assertion.

// Named IERC20Min, not IERC20: a bare "IERC20" here collides with the OpenZeppelin
// IERC20 artifact (both named plainly "IERC20"), which makes every getContractAt("IERC20", ...)
// in the suite ambiguous (Hardhat HHE1001) the moment this file is compiled alongside it.
interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract PoolPoker {
    uint160 private constant MIN_SQRT = 4295128740; // MIN_SQRT_RATIO + 1
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341; // MAX_SQRT_RATIO - 1

    // exact-input swap of `amountIn` into `pool` in the given direction (amountSpecified > 0).
    function poke(address pool, bool zeroForOne, uint256 amountIn) external returns (int256 a0, int256 a1) {
        (a0, a1) = IV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, "");
    }

    // V2 variant: transfer `amountIn` of the input token to the pair, then swap it out. feeNum is
    // the fee-kept numerator out of 10000 (Pancake V2 = 9975 for 0.25%). Fund this with amountIn.
    function pokeV2(address pair, bool zeroForOne, uint256 amountIn, uint256 feeNum) external {
        (uint112 r0, uint112 r1, ) = IV2Pair(pair).getReserves();
        address tin = zeroForOne ? IV2Pair(pair).token0() : IV2Pair(pair).token1();
        IERC20Min(tin).transfer(pair, amountIn);
        uint256 inWithFee = amountIn * feeNum;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 out = (inWithFee * rOut) / (rIn * 10000 + inWithFee);
        if (zeroForOne) IV2Pair(pair).swap(0, out, address(this), "");
        else IV2Pair(pair).swap(out, 0, address(this), "");
    }

    // Both callback names, PancakeV3's and UniV3's, pay the pool whatever we owe from our balance.
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }

    function _pay(int256 a0, int256 a1) internal {
        // msg.sender is the pool.
        if (a0 > 0) IERC20Min(IV3Pool(msg.sender).token0()).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20Min(IV3Pool(msg.sender).token1()).transfer(msg.sender, uint256(a1));
    }
}
