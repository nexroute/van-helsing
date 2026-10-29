// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { Chain } from "./Chain.sol";

// The wrapped native currency's interface (Chain.WRAPPED_NATIVE), for wrapping and unwrapping
// the native currency at the take/settle boundary.
interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256) external;
}

// A singleton pool's config, packed (no abi headers) and read field by field in assembly,
// so an adapter loads only the bytes it needs, with no abi.decode and no struct copied into
// memory. Layout (99 bytes), as the registry's configOf gives it:
//
//   [ 0]  uint8   kind          (Uniswap V4 == 4, Pancake Infinity CL == 6)
//   [ 1]  address currency0     (the pool's own currency; native == address(0))
//   [21]  address currency1
//   [41]  uint24  fee
//   [44]  int24   tickSpacing   (Pancake's is inside `parameters` too)
//   [47]  address hooks
//   [67]  bytes32 parameters    (Pancake Infinity)
//
// A `bytes memory` value's data starts at add(cfg, 32), so field at packed offset O is
// mload(add(cfg, 32 + O)) shifted down to its width. Also home to what both singleton
// adapters share: the wrapped native currency, the sqrt bounds (Uniswap's and Pancake's
// TickMath bounds are identical), price inversion, alignment, and where each manager keeps
// its pools.
library V4Config {
    address internal constant WRAPPED_NATIVE = Chain.WRAPPED_NATIVE;

    // TickMath sqrt-ratio bounds, the extreme swap limits for a sink (a drive uses the
    // meeting-price target instead).
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    // Where the two managers keep their pools: each pool's state laid out as Uniswap's
    // StateLibrary has it (slot0 first, the liquidity 3 slots on, the ticks 4 on, the tick
    // bitmap 5 on), in a pools mapping at slot 6 of Uniswap's PoolManager and 4 of Pancake's
    // CLPoolManager.
    uint256 internal constant UNI_POOLS = 6;
    uint256 internal constant CL_POOLS = 4;
    uint256 internal constant LIQUIDITY_OFFSET = 3;
    uint256 internal constant TICKS_OFFSET = 4;
    uint256 internal constant TICK_BITMAP_OFFSET = 5;

    // The slot where a mapping at `slot` keeps the value of `key`.
    function mapSlot(bytes32 key, uint256 slot) internal pure returns (uint256 s) {
        assembly ("memory-safe") {
            mstore(0, key)
            mstore(0x20, slot)
            s := keccak256(0, 0x40)
        }
    }

    // One slot of the manager's storage, through its extsload(slot).
    function load(address manager, uint256 slot) internal view returns (uint256 v) {
        assembly ("memory-safe") {
            mstore(0, 0x1e2eaeaf) // extsload(bytes32)
            mstore(0x20, slot)
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), manager, 0x1c, 0x24, 0, 0x20))) {
                revert(0, 0)
            }
            v := mload(0)
        }
    }

    function kind(bytes memory cfg) internal pure returns (uint8 v) {
        assembly ("memory-safe") { v := shr(248, mload(add(cfg, 0x20))) }
    }

    function currency0(bytes memory cfg) internal pure returns (address v) {
        assembly ("memory-safe") { v := shr(96, mload(add(cfg, 0x21))) }
    }

    function currency1(bytes memory cfg) internal pure returns (address v) {
        assembly ("memory-safe") { v := shr(96, mload(add(cfg, 0x35))) }
    }

    function fee(bytes memory cfg) internal pure returns (uint24 v) {
        assembly ("memory-safe") { v := shr(232, mload(add(cfg, 0x49))) }
    }

    function tickSpacing(bytes memory cfg) internal pure returns (int24 v) {
        assembly ("memory-safe") { v := shr(232, mload(add(cfg, 0x4c))) }
    }

    function hooks(bytes memory cfg) internal pure returns (address v) {
        assembly ("memory-safe") { v := shr(96, mload(add(cfg, 0x4f))) }
    }

    function parameters(bytes memory cfg) internal pure returns (bytes32 v) {
        assembly ("memory-safe") { v := mload(add(cfg, 0x63)) }
    }

    // Whether the pool's currency order matches the ERC20 token order VanHelsing works in.
    // A native currency (address(0)) is always currency0, but a pair keys it as the wrapped
    // native currency, which sorts after any token with a lower address: such a pool is
    // flipped, its sqrtPrice the inverse of the pair's t1/t0 price and its swap directions
    // reversed. All-ERC20 pools are aligned. Computed from the two currencies alone.
    function aligned(bytes memory cfg) internal pure returns (bool) {
        return erc20(currency0(cfg)) < erc20(currency1(cfg));
    }

    // Invert a sqrtPriceX96 between currency and token space: price_token = 1/price_ccy,
    // so sqrtP_token = 2^192 / sqrtP_ccy (2^192 fits a uint256, so a plain divide).
    // Clamped to the tick bounds; self-inverse up to integer rounding, which the arb
    // tolerates (the floor and atomic settle backstop a mis-size).
    function invertSqrt(uint160 s) internal pure returns (uint160) {
        uint256 inv = (uint256(1) << 192) / s;
        if (inv < MIN_SQRT) return MIN_SQRT;
        if (inv > MAX_SQRT) return MAX_SQRT;
        return uint160(inv);
    }

    // The ERC20 equivalent of a pool currency: native (address(0)) maps to the wrapped native
    // currency, every other currency is itself. Lets a caller compare a singleton pool's currencies
    // against ERC20 pair tokens.
    function erc20(address c) internal pure returns (address) {
        return c == address(0) ? WRAPPED_NATIVE : c;
    }
}
