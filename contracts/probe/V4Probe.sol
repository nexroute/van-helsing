// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { Chain } from "../libraries/Chain.sol";

// The Van Helsing node's pool probe for this singleton: an exact-input swap of any pool, hooks
// included, paid from and taken to the probe's own balances. The node places it in a
// simulated state and funds it from the singleton's custody. It is never deployed on-chain.
// Derived from contracts/test's pool helper, swaps only.
contract V4Probe {
    using SafeTransferLib for address;

    IPoolManager internal constant PM = IPoolManager(Chain.UNI_V4_POOL_MANAGER);

    // Swap amountIn of the input currency; returns the output taken.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        return abi.decode(PM.unlock(abi.encode(key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "AUTH");
        (PoolKey memory key, bool zfo, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        uint160 limit = zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta delta = PM.swap(key, SwapParams(zfo, -int256(amountIn), limit), "");
        return abi.encode(_close(key.currency0, delta.amount0()) + _close(key.currency1, delta.amount1()));
    }

    // Pay what this contract owes in a currency, or take what it is owed; returns the take.
    function _close(Currency currency, int128 amount) private returns (uint256) {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency.isAddressZero()) {
                PM.settle{ value: owed }();
            } else {
                PM.sync(currency);
                Currency.unwrap(currency).safeTransfer(address(PM), owed);
                PM.settle();
            }
            return 0;
        }
        if (amount > 0) PM.take(currency, address(this), uint256(uint128(amount)));
        return uint256(uint128(amount));
    }

    receive() external payable {}
}
