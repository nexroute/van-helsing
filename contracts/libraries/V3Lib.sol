// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";

interface IUniV3Pool {
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

using SafeTransferLib for address;

// Minimal Uniswap V3 adapter, like V2Lib: the reads normalize() needs and the
// output-first swaps the restore drives and sinks with. Every V3 swap is a flash
// (the pool sends the output, then calls back for payment), so driveTo and sink both
// pay in the caller's callback. The caller (VanHelsing) owns the callback-context
// slot and the callback data; this library holds only stateless primitives. See V2Lib for
// the constant-product counterpart.
library V3Lib {
    // TickMath sqrt-ratio bounds, used as the extreme swap limits.
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    // The pool's sqrtPriceX96, the first word slot0() returns; reverts when it does not fit
    // a uint160.
    function price(address pool) internal view returns (uint160 s) {
        assembly ("memory-safe") {
            mstore(0, 0x3850c7bd) // slot0()
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), pool, 0x1c, 0x04, 0, 0x20))) { revert(0, 0) }
            s := mload(0)
            if shr(160, s) { revert(0, 0) }
        }
    }

    // An Algebra Integral pool's sqrtPriceX96 and the fee its plugin last set, in millionths: the
    // first and third words globalState() returns (it has no slot0). Reverts as price does.
    function algebraState(address pool) internal view returns (uint160 s, uint256 fee) {
        assembly ("memory-safe") {
            mstore(0, 0xe76c01e4) // globalState()
            if iszero(and(gt(returndatasize(), 0x5f), staticcall(gas(), pool, 0x1c, 0x04, 0, 0x20))) { revert(0, 0) }
            s := mload(0)
            if shr(160, s) { revert(0, 0) }
            returndatacopy(0, 0x40, 0x20)
            fee := and(mload(0), 0xffff)
        }
    }

    function liquidity(address pool) internal view returns (uint128) {
        return IUniV3Pool(pool).liquidity();
    }

    // Drive `pool` to `target`: an exact-in swap capped at the sqrtPrice limit, so
    // the pool walks its real ticks to `target` and sends the output first. Repaid
    // by the caller's swap callback.
    function driveTo(address pool, bool zeroForOne, uint160 target, bytes memory data) internal {
        IUniV3Pool(pool).swap(address(this), zeroForOne, type(int256).max / 2, target, data);
    }

    // Sink into `pool` at the price `limit` (0: the extreme limit): exact-in (amount > 0, spend
    // all) or exact-out (amount < 0, buy exactly). The pool sends output and calls back. An
    // exact-in sale the pool stops short, at the limit or past its last liquidity, fails: what it
    // did not take would stay here.
    function sink(address pool, bool zeroForOne, int256 amount, uint160 limit, bytes memory data) internal {
        if (limit == 0) limit = zeroForOne ? MIN_SQRT : MAX_SQRT;
        (int256 a0, int256 a1) = IUniV3Pool(pool).swap(address(this), zeroForOne, amount, limit, data);
        if (amount > 0) require((zeroForOne ? a0 : a1) == amount, "SINK_SHORT");
    }

    // The input a swap callback must repay: the positive of the two token deltas.
    function owed(int256 amount0Delta, int256 amount1Delta) internal pure returns (uint256) {
        return amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
    }

    // Pay a sink callback: transfer the owed token (encoded in the callback data) to
    // the pool (msg.sender). The positive delta is the amount, or with `all` the whole
    // balance: a taxed exact-in sale asked the pool for what arrives of it.
    function pay(bytes calldata data) internal {
        (int256 a0, int256 a1, bytes memory cd) = abi.decode(data[4:], (int256, int256, bytes));
        (address token, bool all) = abi.decode(cd, (address, bool));
        token.safeTransfer(msg.sender, all ? token.balanceOf(address(this)) : owed(a0, a1));
    }
}
