// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { PoolKey } from "@pancakeswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@pancakeswap/v4-core/src/types/Currency.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { InfinityLib, IInfinityCL, IInfinityVault } from "../libraries/InfinityLib.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { Chain } from "../libraries/Chain.sol";

// The Van Helsing node's pool probe for this singleton: an exact-input swap of any pool, hooks
// included, paid from and taken to the probe's own balances. The node places it in a
// simulated state and funds it from the singleton's custody. It is never deployed on-chain.
// Derived from contracts/test's pool helper, swaps only.
contract InfinityProbe {
    using SafeTransferLib for address;

    IInfinityVault internal constant VAULT = IInfinityVault(Chain.INFINITY_VAULT);
    IInfinityCL internal constant CL = IInfinityCL(Chain.INFINITY_CL_POOL_MANAGER);

    // Swap amountIn of the input currency; returns the output taken.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        return abi.decode(VAULT.lock(abi.encode(key, zeroForOne, amountIn)), (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(VAULT), "AUTH");
        (PoolKey memory key, bool zfo, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        uint160 limit = zfo ? V4Config.MIN_SQRT : V4Config.MAX_SQRT;
        // The BalanceDelta packing: amount0 in the high 128 bits, amount1 in the low.
        int256 delta = CL.swap(key, InfinityLib.SwapParams(zfo, -int256(amountIn), limit), "");
        return abi.encode(_close(key.currency0, int128(delta >> 128)) + _close(key.currency1, int128(delta)));
    }

    // Pay what this contract owes in a currency, or take what it is owed; returns the take.
    function _close(Currency currency, int128 amount) private returns (uint256) {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency.isNative()) {
                VAULT.settle{ value: owed }();
            } else {
                VAULT.sync(currency);
                Currency.unwrap(currency).safeTransfer(address(VAULT), owed);
                VAULT.settle();
            }
            return 0;
        }
        if (amount > 0) VAULT.take(currency, address(this), uint256(uint128(amount)));
        return uint256(uint128(amount));
    }

    receive() external payable {}
}
