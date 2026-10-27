// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { InfinityLib } from "../libraries/InfinityLib.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { PoolId } from "@pancakeswap/v4-core/src/types/PoolId.sol";

// Exposes InfinityLib's reads plus a single-lock round-trip for unit tests. `cfg` is the
// packed pool config (see V4Config).
contract InfinityLibHarness {
    function normalize(bytes calldata cfg) external view returns (uint160 s, uint128 l) {
        return (InfinityLib.price(cfg), InfinityLib.liquidity(cfg));
    }

    function liquidity(bytes calldata cfg) external view returns (uint128) {
        return InfinityLib.liquidity(cfg);
    }

    function idOf(bytes calldata cfg) external pure returns (bytes32) {
        return PoolId.unwrap(InfinityLib.poolId(cfg));
    }

    // Pre-fund this contract with `amountIn` of the input currency, then swap exact-in.
    function swapOnce(bytes calldata cfg, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        bytes memory ret = InfinityLib.unlock(abi.encode(cfg, zeroForOne, amountIn));
        amountOut = abi.decode(ret, (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(InfinityLib.VAULT), "AUTH");
        (bytes memory cfg, bool zeroForOne, uint256 amountIn) = abi.decode(data, (bytes, bool, uint256));
        (uint256 debt, uint256 amountOut) =
            InfinityLib.swapTo(cfg, zeroForOne, -int256(amountIn), zeroForOne ? V4Config.MIN_SQRT : V4Config.MAX_SQRT);
        InfinityLib.settle(cfg, zeroForOne, debt);
        return abi.encode(amountOut);
    }

    receive() external payable {}
}
