// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { PoolKey } from "@pancakeswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@pancakeswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@pancakeswap/v4-core/src/types/Currency.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { InfinityLib, IInfinityVault } from "../libraries/InfinityLib.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { Chain } from "../libraries/Chain.sol";

// What this helper calls of Pancake's CLPoolManager, declared as Pancake's ICLPoolManager declares
// it, each BalanceDelta read as the int256 it packs (amount0 in the high 128 bits, amount1 in the
// low).
interface ICLPoolManagerCalls {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 delta, int256 feeDelta);
    function swap(PoolKey memory key, InfinityLib.SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function getSlot0(PoolId id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getFeeGrowthGlobals(PoolId id)
        external
        view
        returns (uint256 feeGrowthGlobal0x128, uint256 feeGrowthGlobal1x128);
}

// A minimal Pancake Infinity CL router for the fork tests: adds liquidity to and swaps
// exact-in through any pool, hooks included, paying from and taking to its own balances.
contract InfinityPoolHelper {
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for address;

    IInfinityVault internal constant VAULT = IInfinityVault(Chain.INFINITY_VAULT);
    ICLPoolManagerCalls internal constant CL = ICLPoolManagerCalls(Chain.INFINITY_CL_POOL_MANAGER);

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external {
        VAULT.lock(abi.encode(false, key, abi.encode(tickLower, tickUpper, liquidity)));
    }

    // Swap amountIn of the input currency; returns the output taken.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        return abi.decode(VAULT.lock(abi.encode(true, key, abi.encode(zeroForOne, amountIn))), (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(VAULT), "AUTH");
        (bool isSwap, PoolKey memory key, bytes memory args) = abi.decode(data, (bool, PoolKey, bytes));
        int256 delta;
        if (isSwap) {
            (bool zfo, uint256 amountIn) = abi.decode(args, (bool, uint256));
            uint160 limit = zfo ? V4Config.MIN_SQRT : V4Config.MAX_SQRT;
            delta = CL.swap(key, InfinityLib.SwapParams(zfo, -int256(amountIn), limit), "");
        } else {
            (int24 lower, int24 upper, int256 liquidity) = abi.decode(args, (int24, int24, int256));
            (delta,) = CL.modifyLiquidity(key, ICLPoolManagerCalls.ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        }
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

    function price(PoolKey calldata key) external view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = CL.getSlot0(key.toId());
    }

    function feeGrowth(PoolKey calldata key) external view returns (uint256 global0, uint256 global1) {
        return CL.getFeeGrowthGlobals(key.toId());
    }

    receive() external payable { }
}
