// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { UniV4Lib } from "../libraries/UniV4Lib.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

// Exposes UniV4Lib's view reads for the tests. `cfg` is the packed pool config
// (see V4Config), the same blob the registry stores and VanHelsing hands the adapter.
contract UniV4LibHarness {
    function normalize(bytes calldata cfg) external view returns (uint160 s, uint128 l) {
        return (UniV4Lib.price(cfg), UniV4Lib.liquidity(cfg));
    }

    function liquidity(bytes calldata cfg) external view returns (uint128) {
        return UniV4Lib.liquidity(cfg);
    }

    // The id VanHelsing/the registry key V4 pools by: the full poolId.
    function idOf(bytes calldata cfg) external pure returns (bytes32) {
        return PoolId.unwrap(UniV4Lib.poolId(cfg));
    }

    // Single-lock round-trip exercising the execution primitives in isolation: swap
    // `amountIn` of the input currency exact-in (this contract must be pre-funded with
    // it), take the output, settle the debt. Returns the output received.
    function swapOnce(bytes calldata cfg, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        bytes memory ret = UniV4Lib.unlock(abi.encode(cfg, zeroForOne, amountIn));
        amountOut = abi.decode(ret, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(UniV4Lib.POOL_MANAGER), "AUTH");
        (bytes memory cfg, bool zeroForOne, uint256 amountIn) = abi.decode(data, (bytes, bool, uint256));
        (uint256 debt, uint256 amountOut) =
            UniV4Lib.swapTo(cfg, zeroForOne, -int256(amountIn), zeroForOne ? V4Config.MIN_SQRT : V4Config.MAX_SQRT);
        UniV4Lib.settle(cfg, zeroForOne, debt);
        return abi.encode(amountOut);
    }

    receive() external payable {}
}
