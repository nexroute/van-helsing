// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { UniV4Lib } from "../libraries/UniV4Lib.sol";
import { InfinityLib } from "../libraries/InfinityLib.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { IWard } from "../interfaces/IWard.sol";

// Calls ward from inside a lock it holds, as a Uniswap V4 hook or a router's unlock callback does:
// the Uniswap V4 PoolManager's (unlock) or the Pancake Infinity Vault's (lock). With
// amountIn set, it first swaps that much on `cfg` (it must hold the input) and settles its
// own debt, so the ward runs right after a swap, in the same lock.
contract LockHolder {
    function wardInV4Lock(address vh, bytes32 id, address payee, bytes calldata cfg, bool zeroForOne, uint256 amountIn)
        external
    {
        UniV4Lib.unlock(abi.encode(vh, id, payee, cfg, zeroForOne, amountIn));
    }

    function wardInInfinityLock(
        address vh,
        bytes32 id,
        address payee,
        bytes calldata cfg,
        bool zeroForOne,
        uint256 amountIn
    ) external {
        InfinityLib.unlock(abi.encode(vh, id, payee, cfg, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(UniV4Lib.POOL_MANAGER), "AUTH");
        (address vh, bytes32 id, address payee, bytes memory cfg, bool zfo, uint256 amountIn) =
            abi.decode(data, (address, bytes32, address, bytes, bool, uint256));
        if (amountIn > 0) {
            (uint256 debt,) =
                UniV4Lib.swapTo(cfg, zfo, -int256(amountIn), zfo ? V4Config.MIN_SQRT : V4Config.MAX_SQRT);
            UniV4Lib.settle(cfg, zfo, debt);
        }
        IWard(vh).ward(id, payee);
        return "";
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(InfinityLib.VAULT), "AUTH");
        (address vh, bytes32 id, address payee, bytes memory cfg, bool zfo, uint256 amountIn) =
            abi.decode(data, (address, bytes32, address, bytes, bool, uint256));
        if (amountIn > 0) {
            (uint256 debt,) =
                InfinityLib.swapTo(cfg, zfo, -int256(amountIn), zfo ? V4Config.MIN_SQRT : V4Config.MAX_SQRT);
            InfinityLib.settle(cfg, zfo, debt);
        }
        IWard(vh).ward(id, payee);
        return "";
    }

    receive() external payable {}
}
