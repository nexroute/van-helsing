// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { PoolKey } from "@pancakeswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@pancakeswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@pancakeswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@pancakeswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@pancakeswap/v4-core/src/interfaces/IPoolManager.sol";
import { ILockCallback } from "@pancakeswap/v4-core/src/interfaces/ILockCallback.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { V4Config, IWBNB } from "./V4Config.sol";

// What this adapter calls of Pancake Infinity, declared as Pancake's ICLPoolManager and IVault
// declare it: the CLPoolManager's swap, its BalanceDelta read as the int256 it packs (amount0 in
// the high 128 bits, amount1 in the low), and the Vault's lock and accounting.
interface IInfinityCL {
    function swap(PoolKey memory key, InfinityLib.SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
}

interface IInfinityVault {
    function getLocker() external view returns (address locker);
    function lock(bytes calldata data) external returns (bytes memory);
    function take(Currency currency, address to, uint256 amount) external;
    function sync(Currency currency) external;
    function settle() external payable returns (uint256 paid);
}

// Minimal Pancake Infinity CL adapter. Same singleton model as Uniswap V4, but split
// across the Vault (lock/take/settle/sync) + CLPoolManager (swap/state). The PoolKey
// carries a `parameters` bytes32 (tickSpacing + hook flags) instead of a flat tickSpacing,
// and the callback is lockAcquired (vault.lock) not unlockCallback. Reads the packed
// config field by field in assembly (V4Config: no abi.decode) and reuses V4Config's
// alignment, inversion, WBNB and sqrt bounds (Pancake's TickMath bounds match Uniswap's).
library InfinityLib {
    // The CLPoolManager's swap parameters, as Pancake's ICLPoolManager declares them. A pool's
    // price and liquidity are read from the manager's storage (V4Config.load).
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for address;

    // Pancake Infinity on BNB Chain: the CLPoolManager (swap + state) and the Vault (the
    // one lock + accounting for every Infinity pool).
    IInfinityCL internal constant CL = IInfinityCL(0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b);
    IInfinityVault internal constant VAULT = IInfinityVault(0x238a358808379702088667322f80aC48bAd5e6c4);

    function key(bytes memory cfg) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(V4Config.currency0(cfg)),
            currency1: Currency.wrap(V4Config.currency1(cfg)),
            hooks: IHooks(V4Config.hooks(cfg)),
            poolManager: IPoolManager(address(CL)),
            fee: V4Config.fee(cfg),
            parameters: V4Config.parameters(cfg)
        });
    }

    function poolId(bytes memory cfg) internal pure returns (PoolId) {
        return key(cfg).toId();
    }

    // Price in token space (t1/t0); a flipped (native) pool quotes the inverse.
    function price(bytes memory cfg) internal view returns (uint160 s) {
        s = uint160(V4Config.load(address(CL), _state(cfg)));
        if (!V4Config.aligned(cfg)) s = V4Config.invertSqrt(s);
    }

    function liquidity(bytes memory cfg) internal view returns (uint128) {
        unchecked {
            return uint128(V4Config.load(address(CL), _state(cfg) + V4Config.LIQUIDITY_OFFSET));
        }
    }

    // The pool's state slot in the CLPoolManager.
    function _state(bytes memory cfg) private pure returns (uint256) {
        return V4Config.mapSlot(PoolId.unwrap(poolId(cfg)), V4Config.CL_POOLS);
    }

    // Take the Vault's lock; the caller's lockAcquired runs `data`. When the Vault is
    // already locked (a Pancake hook, a router's own lock callback), a second lock would
    // revert, so the caller's lockAcquired runs directly inside the held lock: the Vault
    // books deltas per settler, and ours net to zero the same way.
    function unlock(bytes memory data) public returns (bytes memory) {
        if (VAULT.getLocker() != address(0)) return ILockCallback(address(this)).lockAcquired(data);
        return VAULT.lock(data);
    }

    // Inside the lock: swap on the CLPoolManager and take the output from the Vault to
    // this contract (native wrapped to WBNB). Token-space direction/limit are translated
    // to currency space (a flipped pool reverses the direction and inverts the limit).
    // Returns the input debt and the output.
    function swapTo(bytes memory cfg, bool zeroForOne, int256 amountSpecified, uint160 sqrtLimit)
        public
        returns (uint256 debt, uint256 amountOut)
    {
        PoolKey memory k = key(cfg);
        bool a = V4Config.aligned(cfg);
        bool zfo = a ? zeroForOne : !zeroForOne;
        int256 delta = CL.swap(k, SwapParams(zfo, amountSpecified, a ? sqrtLimit : V4Config.invertSqrt(sqrtLimit)), "");
        Currency cOut;
        if (zfo) {
            cOut = k.currency1;
            debt = uint256(uint128(-int128(delta >> 128)));
            amountOut = uint256(uint128(int128(delta)));
        } else {
            cOut = k.currency0;
            debt = uint256(uint128(-int128(delta)));
            amountOut = uint256(uint128(int128(delta >> 128)));
        }
        VAULT.take(cOut, address(this), amountOut);
        if (cOut.isNative()) IWBNB(V4Config.WBNB).deposit{value: amountOut}();
    }

    // Pay `debt` of the input currency to the Vault (native unwrapped from WBNB) and
    // return what it credited: less than `debt` when the token takes a fee on transfer.
    function settle(bytes memory cfg, bool zeroForOne, uint256 debt) public returns (uint256 paid) {
        bool zfo = V4Config.aligned(cfg) ? zeroForOne : !zeroForOne;
        PoolKey memory k = key(cfg);
        Currency cIn = zfo ? k.currency0 : k.currency1;
        VAULT.sync(cIn);
        if (cIn.isNative()) {
            IWBNB(V4Config.WBNB).withdraw(debt);
            return VAULT.settle{value: debt}();
        }
        Currency.unwrap(cIn).safeTransfer(address(VAULT), debt);
        return VAULT.settle();
    }

    // Settle a debt in full. Whatever the Vault does not receive of it stays owed, and inside a
    // lock someone else holds that would surface only when their lock closes, reverting their
    // whole transaction (a token taxed into the Vault that the registry states untaxed).
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
        VAULT.take(cIn, address(this), paid - used);
        if (cIn.isNative()) IWBNB(V4Config.WBNB).deposit{value: paid - used}();
    }
}
