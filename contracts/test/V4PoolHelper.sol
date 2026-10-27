// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { V4Config } from "../libraries/V4Config.sol";

// A minimal Uniswap V4 router for the fork tests: adds liquidity to and swaps exact-in through any
// pool, hooks included, paying from and taking to its own balances (fund it first).
contract V4PoolHelper {
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for address;

    IPoolManager internal constant PM = IPoolManager(0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF);

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external {
        PM.unlock(abi.encode(false, key, abi.encode(tickLower, tickUpper, liquidity)));
    }

    // Swap amountIn of the input currency; returns the output taken.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        return abi.decode(PM.unlock(abi.encode(true, key, abi.encode(zeroForOne, amountIn))), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "AUTH");
        (bool isSwap, PoolKey memory key, bytes memory args) = abi.decode(data, (bool, PoolKey, bytes));
        BalanceDelta delta;
        if (isSwap) {
            (bool zfo, uint256 amountIn) = abi.decode(args, (bool, uint256));
            uint160 limit = zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
            delta = PM.swap(key, SwapParams(zfo, -int256(amountIn), limit), "");
        } else {
            (int24 lower, int24 upper, int256 liquidity) = abi.decode(args, (int24, int24, int256));
            (delta,) = PM.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        }
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

    // The pool's price and tick: its slot0, read from the PoolManager's storage.
    function price(PoolKey calldata key) external view returns (uint160 sqrtPriceX96, int24 tick) {
        uint256 w = V4Config.load(address(PM), _state(key));
        (sqrtPriceX96, tick) = (uint160(w), int24(int256(w >> 160)));
    }

    // The pool's fee growth, the two slots after its slot0.
    function feeGrowth(PoolKey calldata key) external view returns (uint256 global0, uint256 global1) {
        uint256 s = _state(key);
        return (V4Config.load(address(PM), s + 1), V4Config.load(address(PM), s + 2));
    }

    // The pool's state slot in the PoolManager.
    function _state(PoolKey calldata key) private pure returns (uint256) {
        return V4Config.mapSlot(PoolId.unwrap(key.toId()), V4Config.UNI_POOLS);
    }

    receive() external payable { }
}
