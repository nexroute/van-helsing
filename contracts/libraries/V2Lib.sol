// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

interface IUniswapV2PairMin {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

using SafeTransferLib for address;

// Minimal Uniswap V2 adapter, scoped to what VanHelsing does with a pair: read its
// reserves, the constant-product amount math, and the swaps. Fee is passed as
// (feeNum, feeDen) = (feeDen - fee, feeDen), feeDen 1e4 for the V2 family (so 0.25% is
// 9975/10000).
library V2Lib {
    // reserve0 and reserve1, the first two words getReserves() returns, in the pair's
    // token0/token1 (address-sorted) order.
    function getReserves(address pair) internal view returns (uint256 r0, uint256 r1) {
        assembly ("memory-safe") {
            mstore(0, 0x0902f1ac) // getReserves()
            if iszero(and(gt(returndatasize(), 0x3f), staticcall(gas(), pair, 0x1c, 0x04, 0, 0x40))) { revert(0, 0) }
            r0 := mload(0)
            r1 := mload(0x20)
        }
    }

    function amountOut(uint256 amtIn, uint256 rIn, uint256 rOut, uint256 feeNum, uint256 feeDen)
        internal
        pure
        returns (uint256)
    {
        unchecked {
            return (amtIn * feeNum * rOut) / (rIn * feeDen + amtIn * feeNum);
        }
    }

    function amountIn(uint256 amtOut, uint256 rIn, uint256 rOut, uint256 feeNum, uint256 feeDen)
        internal
        pure
        returns (uint256)
    {
        unchecked {
            return (rIn * amtOut * feeDen) / ((rOut - amtOut) * feeNum) + 1;
        }
    }

    uint256 internal constant Q96 = 1 << 96;

    // Fee-aware amount of tokenIn to swap into a constant-product pool to move its
    // marginal price to `targetSqrtP`. zeroForOne adds token0 (lowers price token1/
    // token0); !zeroForOne adds token1 (raises it). Reserves in token0/token1 order.
    // Solving marginal' = rIn*rOut/((rIn+a*r)(rIn+a)) = target for a (r = feeNum/feeDen)
    // gives r*a^2 + rIn*(1+r)*a + (rIn^2 - K) = 0 with K = rIn*rOut/targetMarginal;
    // scaled by feeDen the discriminant is rIn^2*(fd-fn)^2 + 4*fn*fd*K, which stays under
    // 2^256 while K is under about 2^227 (any realistic pool; at full uint112 reserves, a target
    // within about 10x of the price); past that the checked math reverts. Returns 0 if the pool
    // is already at or past the target in that direction.
    function driveAmount(
        uint256 r0,
        uint256 r1,
        uint256 feeNum,
        uint256 feeDen,
        uint160 targetSqrtP,
        bool zeroForOne
    ) internal pure returns (uint256) {
        (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);

        // K = rIn*rOut / targetMarginal, where targetMarginal is the target rOut/rIn.
        // Two fullMulDivs avoid ever forming targetSqrtP^2 (which overflows uint256).
        uint256 rr = rIn * rOut;
        uint256 k = zeroForOne
            ? FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(rr, Q96, targetSqrtP), Q96, targetSqrtP)
            : FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(rr, targetSqrtP, Q96), targetSqrtP, Q96);
        if (k <= rIn * rIn) return 0; // target is at or on the wrong side of the current price

        uint256 diff = feeDen - feeNum;
        uint256 d = rIn * rIn * diff * diff + 4 * feeNum * feeDen * k;
        uint256 s = FixedPointMathLib.sqrt(d);
        uint256 sub = rIn * (feeDen + feeNum);
        if (s <= sub) return 0;
        return (s - sub) / (2 * feeNum);
    }

    // Pre-funded swap: send `amtIn` of tokenIn to the pair, pull `amtOut` of the
    // other token to `to`. zeroForOne means tokenIn is token0 (output is token1).
    function swapTo(address pair, address tokenIn, uint256 amtIn, uint256 amtOut, bool zeroForOne, address to)
        internal
    {
        tokenIn.safeTransfer(pair, amtIn);
        if (zeroForOne) {
            IUniswapV2PairMin(pair).swap(0, amtOut, to, "");
        } else {
            IUniswapV2PairMin(pair).swap(amtOut, 0, to, "");
        }
    }

    // Pre-funded exact-in swap of `amtIn` of tokenIn, priced on what the pair actually
    // received (the "supporting fee-on-transfer" pattern): a token that takes a fee on
    // transfer delivers less than `amtIn`, and one that swaps its collected fee into the
    // pair mid-transfer moves the reserves, so both are read after the transfer.
    function swapAllIn(
        address pair,
        address tokenIn,
        uint256 amtIn,
        bool zeroForOne,
        uint256 feeNum,
        uint256 feeDen,
        address to
    ) internal {
        tokenIn.safeTransfer(pair, amtIn);
        (uint256 r0, uint256 r1) = getReserves(pair);
        (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
        flash(pair, amountOut(tokenIn.balanceOf(pair) - rIn, rIn, rOut, feeNum, feeDen), zeroForOne, to, "");
    }

    // Pull `amtOut` of the output token to `to`: with `data`, a flash swap whose callback must
    // repay the pair; with none, a plain swap of what was sent to the pair first (swapAllIn).
    // zeroForOne means the output is token1 (the output of a token0->token1 swap).
    function flash(address pair, uint256 amtOut, bool zeroForOne, address to, bytes memory data) internal {
        if (zeroForOne) {
            IUniswapV2PairMin(pair).swap(0, amtOut, to, data);
        } else {
            IUniswapV2PairMin(pair).swap(amtOut, 0, to, data);
        }
    }
}
