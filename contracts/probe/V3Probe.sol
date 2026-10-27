// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";

interface IV3PoolProbed {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

// The Van Helsing node's V3 probe: an exact-input swap of a pool, paid from the probe's own
// balance through whichever callback the pool calls. The node places it in a simulated
// state, funds it from the pool's own custody and reads what the trade did. It is never
// deployed on-chain.
contract V3Probe {
    using SafeTransferLib for address;

    uint160 private constant MIN_SQRT = 4295128740; // TickMath.MIN_SQRT_RATIO + 1
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341; // MAX_SQRT_RATIO - 1

    // Swaps amountIn of the input token; returns the pool's two amounts, positive into it.
    function swap(address pool, bool zeroForOne, uint256 amountIn) external returns (int256 a0, int256 a1) {
        (a0, a1) = IV3PoolProbed(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, "");
    }

    // Any V3 fork's swap callback, uniswapV3SwapCallback, pancakeV3SwapCallback or another
    // name, as VanHelsing's own fallback takes them: (int256 amount0Delta, int256 amount1Delta,
    // bytes data).
    fallback() external {
        (int256 a0, int256 a1) = abi.decode(msg.data[4:68], (int256, int256));
        if (a0 > 0) IV3PoolProbed(msg.sender).token0().safeTransfer(msg.sender, uint256(a0));
        if (a1 > 0) IV3PoolProbed(msg.sender).token1().safeTransfer(msg.sender, uint256(a1));
    }
}
