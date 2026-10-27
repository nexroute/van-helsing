// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { V4Config, IWBNB } from "./V4Config.sol";

// Minimal Uniswap V4 adapter over the singleton PoolManager. A pool has no address of
// its own: it lives inside the one PoolManager and is named by a poolId derived from its
// PoolKey. The caller hands us the pool's packed config; we read the key fields directly
// in assembly (V4Config: no abi.decode, no struct copy), rebuild the PoolKey, and drive or
// sink inside an unlock. The execution half (unlock, swapTo, settle and the rest) is public
// so it links out of VanHelsing's bytecode; the reads (price, liquidity, from the manager's
// storage by poolId, V4Config.load) stay internal, for RouteLib. See V4Config for the shared
// alignment, price-inversion, WBNB and sqrt-bound helpers.
library UniV4Lib {
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for address;

    // Uniswap V4 PoolManager on BNB Chain (the one singleton for every Uniswap V4 pool).
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF);

    // The transient slot where the PoolManager keeps whether it is unlocked, which its exttload
    // reads: keccak256("Unlocked") - 1.
    bytes32 private constant IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;

    // Rebuild the PoolKey from the packed config. currency0/currency1 are the pool's own
    // currencies (native == address(0)), already sorted at registration.
    function key(bytes memory cfg) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(V4Config.currency0(cfg)),
            currency1: Currency.wrap(V4Config.currency1(cfg)),
            fee: V4Config.fee(cfg),
            tickSpacing: V4Config.tickSpacing(cfg),
            hooks: IHooks(V4Config.hooks(cfg))
        });
    }

    function poolId(bytes memory cfg) internal pure returns (PoolId) {
        return key(cfg).toId();
    }

    // Current sqrtPriceX96, presented in VanHelsing's token space (t1/t0). A flipped
    // (native) pool quotes the inverse, so invert it.
    function price(bytes memory cfg) internal view returns (uint160 s) {
        s = uint160(V4Config.load(address(POOL_MANAGER), _state(cfg)));
        if (!V4Config.aligned(cfg)) s = V4Config.invertSqrt(s);
    }

    // Active-tick liquidity (orientation-independent). The effective depth is walked by
    // V4Depth.
    function liquidity(bytes memory cfg) internal view returns (uint128) {
        unchecked {
            return uint128(V4Config.load(address(POOL_MANAGER), _state(cfg) + V4Config.LIQUIDITY_OFFSET));
        }
    }

    // The pool's state slot in the PoolManager.
    function _state(bytes memory cfg) private pure returns (uint256) {
        return V4Config.mapSlot(PoolId.unwrap(poolId(cfg)), V4Config.UNI_POOLS);
    }

    // Take the lock; the caller's unlockCallback runs `data` and must net its deltas to
    // zero before this returns (or the whole frame reverts: the fundless self-repay).
    // When the lock is already open (a V4 hook, a router's own unlock callback), a second
    // unlock would revert, so the caller's unlockCallback runs directly inside the open
    // lock: the PoolManager books deltas per caller, and ours net to zero the same way.
    function unlock(bytes memory data) public returns (bytes memory) {
        if (POOL_MANAGER.exttload(IS_UNLOCKED_SLOT) != 0) return IUnlockCallback(address(this)).unlockCallback(data);
        return POOL_MANAGER.unlock(data);
    }

    // Inside an unlock: swap per (amountSpecified, sqrtLimit) and receive the output to
    // this contract (native wrapped to WBNB), returning the input debt and the output.
    // VanHelsing passes token-space direction/limit; translate to the pool's currency
    // space (a flipped pool reverses the direction and inverts the limit; amountSpecified
    // is a token quantity, native maps 1:1 to WBNB, so it passes through).
    function swapTo(bytes memory cfg, bool zeroForOne, int256 amountSpecified, uint160 sqrtLimit)
        public
        returns (uint256 debt, uint256 amountOut)
    {
        PoolKey memory k = key(cfg);
        bool a = V4Config.aligned(cfg);
        bool zfo = a ? zeroForOne : !zeroForOne;
        BalanceDelta delta =
            POOL_MANAGER.swap(k, SwapParams(zfo, amountSpecified, a ? sqrtLimit : V4Config.invertSqrt(sqrtLimit)), "");
        Currency cOut;
        if (zfo) {
            cOut = k.currency1;
            debt = uint256(uint128(-delta.amount0()));
            amountOut = uint256(uint128(delta.amount1()));
        } else {
            cOut = k.currency0;
            debt = uint256(uint128(-delta.amount1()));
            amountOut = uint256(uint128(delta.amount0()));
        }
        POOL_MANAGER.take(cOut, address(this), amountOut);
        if (cOut.isAddressZero()) IWBNB(V4Config.WBNB).deposit{value: amountOut}(); // wrap native output
    }

    // Pay `debt` of the input currency to the manager (native unwrapped from WBNB) and
    // return what it credited: less than `debt` when the token takes a fee on transfer.
    function settle(bytes memory cfg, bool zeroForOne, uint256 debt) public returns (uint256 paid) {
        bool zfo = V4Config.aligned(cfg) ? zeroForOne : !zeroForOne; // token space -> currency space
        PoolKey memory k = key(cfg);
        Currency cIn = zfo ? k.currency0 : k.currency1;
        POOL_MANAGER.sync(cIn);
        if (cIn.isAddressZero()) {
            IWBNB(V4Config.WBNB).withdraw(debt);
            return POOL_MANAGER.settle{value: debt}();
        }
        Currency.unwrap(cIn).safeTransfer(address(POOL_MANAGER), debt);
        return POOL_MANAGER.settle();
    }

    // Settle a debt in full. Whatever the manager does not receive of it stays owed, and inside a
    // lock someone else holds that would surface only when their lock closes, reverting their
    // whole transaction (a token taxed into the manager that the registry states untaxed).
    // Failing here fails the ward alone, which ward() swallows.
    function settleDebt(bytes memory cfg, bool zeroForOne, uint256 debt) public {
        require(settle(cfg, zeroForOne, debt) == debt, "SHORT_SETTLE");
    }

    // Inside the lock: sell exactly `amount` of the input currency. Pay first and swap what
    // the singleton credited, which is what a token taking a fee on transfer actually
    // delivered (for any other token it is all of it), then take back whatever the pool
    // could not use before the price limit, as settling only the swap's debt would.
    function sinkIn(bytes memory cfg, bool zeroForOne, uint256 amount) public {
        uint256 paid = settle(cfg, zeroForOne, amount);
        (uint256 used,) = swapTo(cfg, zeroForOne, -int256(paid), zeroForOne ? V4Config.MIN_SQRT : V4Config.MAX_SQRT);
        if (used == paid) return;
        bool zfo = V4Config.aligned(cfg) ? zeroForOne : !zeroForOne;
        PoolKey memory k = key(cfg);
        Currency cIn = zfo ? k.currency0 : k.currency1;
        POOL_MANAGER.take(cIn, address(this), paid - used);
        if (cIn.isAddressZero()) IWBNB(V4Config.WBNB).deposit{value: paid - used}();
    }
}
