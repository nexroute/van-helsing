// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { V4Config } from "./V4Config.sol";

// What a depth walk (V3Depth, V4Depth) took, so that a second walk on the same state toward a
// nearer target in the same direction, sizing's second pass, is replayed instead of reading the
// pool again. Such a walk takes the first one's steps, or the first few of them: where a step ends
// and the liquidity it carries depend on where it starts and on the pool alone, and the target
// only decides at which step the walk clips, which a nearer target does no later.
//
// A record is WORDS words, as bytes. The first: whether the walk is recorded (bit 0, clear when
// it took more steps than the record holds), whether its target was inverted into the pool's
// currency space (1), its direction there, up (2), whether it ended on its step budget (3), the
// steps it took (8-15), the spacing (16-39), the compressed tick it started from (40-63) and
// the compressed target it walked toward (64-87), and the price it started from (96-255). The
// second: the active liquidity it started with. Then each step: the compressed boundary it
// reached (an int24, bits 0-23), whether that is an initialized tick (24), and the liquidity
// once the step is done (32-159): past the boundary, or before it on the step that stops at
// the target. A walk that ends before it starts (no step budget, or its target at its price)
// returns no record.
library DepthRecord {
    // The steps a record holds: as many as VanHelsing lets a walk take (MAX_DEPTH_TICKS).
    uint256 internal constant STEPS = 8;
    uint256 internal constant WORDS = STEPS + 2;

    uint256 internal constant OK = 1;
    uint256 internal constant FLIPPED = 2;
    uint256 internal constant UP = 4;
    uint256 internal constant FULL = 8;

    // A tick in spacing units, floored toward -infinity, as Uniswap v4-core's TickBitmap.compress
    // (Copyright 2023 Universal Navigation Inc., MIT License) has it.
    function compress(int24 tick, int24 spacing) internal pure returns (int24 c) {
        c = tick / spacing;
        if (tick < 0 && tick % spacing != 0) c--;
    }

    // The compressed tick a walk toward sqrtP runs to. getTickAtSqrtPrice reverts out of
    // [MIN_SQRT_PRICE, MAX_SQRT_PRICE); a depth read must never revert, so clamp first.
    function compressedAt(uint160 sqrtP, int24 spacing) internal pure returns (int24) {
        if (sqrtP < TickMath.MIN_SQRT_PRICE) sqrtP = TickMath.MIN_SQRT_PRICE;
        if (sqrtP >= TickMath.MAX_SQRT_PRICE) sqrtP = TickMath.MAX_SQRT_PRICE - 1;
        return compress(TickMath.getTickAtSqrtPrice(sqrtP), spacing);
    }

    // A walk's record, started: its first word (OK and the flags given, its spacing, compressed
    // start and target, and price) and the liquidity it starts with.
    function start(uint256 flags, int24 spacing, int24 pos, int24 target, uint160 cur, uint128 spot)
        internal
        pure
        returns (bytes memory r)
    {
        r = new bytes(WORDS * 32);
        uint256 h = OK | flags | uint256(uint24(spacing)) << 16 | uint256(uint24(pos)) << 40
            | uint256(uint24(target)) << 64 | uint256(cur) << 96;
        assembly ("memory-safe") {
            mstore(add(r, 0x20), h)
            mstore(add(r, 0x40), spot)
        }
    }

    // Note step n of the walk: the boundary it reached, whether that is an initialized tick, and
    // the liquidity once the step is done. A step past the record's room is not kept (finish then says so).
    function note(bytes memory r, uint256 n, int24 b, bool init, uint128 liq) internal pure {
        if (n >= STEPS) return;
        uint256 s = uint256(uint24(b)) | (init ? 1 << 24 : 0) | uint256(liq) << 32;
        assembly ("memory-safe") {
            mstore(add(r, mul(add(n, 3), 0x20)), s)
        }
    }

    // The record's end: the n steps the walk took, whether it ended on its budget, and not
    // recorded when it took more than fit.
    function finish(bytes memory r, uint256 n, bool full) internal pure {
        assembly ("memory-safe") {
            let h := or(or(mload(add(r, 0x20)), shl(8, and(n, 0xff))), mul(full, FULL))
            if gt(n, STEPS) { h := and(h, not(OK)) }
            mstore(add(r, 0x20), h)
        }
    }

    // Word k of a record handed back as calldata.
    function _word(bytes calldata r, uint256 k) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := calldataload(add(r.offset, mul(k, 0x20)))
        }
    }

    // The walk toward targetSqrtP (in token space, as the walk was given its own), replayed from
    // the record of one toward a farther target on the same state, with the same step budget:
    // the walk's own step, line for line, on the recorded boundaries and liquidity. False when
    // the record does not cover it: another direction, a farther target, or steps it does not
    // hold.
    function replay(bytes calldata r, uint160 targetSqrtP) internal pure returns (uint128, bool) {
        if (r.length != WORDS * 32) return (0, false);
        uint256 h = _word(r, 0);
        if (h & OK == 0) return (0, false);
        if (h & FLIPPED != 0) targetSqrtP = V4Config.invertSqrt(targetSqrtP);
        uint160 cur = uint160(h >> 96);
        if (targetSqrtP == cur) return (uint128(_word(r, 1)), true);
        if ((targetSqrtP > cur) != (h & UP != 0)) return (0, false);
        int24 tc = compressedAt(targetSqrtP, int24(uint24(h >> 16)));
        int24 pos = int24(uint24(h >> 40));
        if (tc == pos) return (uint128(_word(r, 1)), true);
        int24 target = int24(uint24(h >> 64));
        if (h & UP != 0 ? tc > target : tc < target) return (0, false);
        return _sum(r, h, pos, tc);
    }

    // The replay's running sums, as the walk keeps them.
    struct Sum {
        uint128 liq;
        int24 pos;
        uint256 wSum; // sum of L_span * width
        uint256 tSum; // sum of widths
    }

    // The span-weighted mean over the recorded steps, clipped at tc, as the walk sums it.
    function _sum(bytes calldata r, uint256 h, int24 pos, int24 tc) private pure returns (uint128, bool) {
        uint128 spot = uint128(_word(r, 1));
        Sum memory a = Sum(spot, pos, 0, 0);
        // Past the recorded steps without clipping or running dry, only the step budget ends the
        // walk, and only when the first walk ended on it too.
        if (_steps(r, h, tc, a) && h & FULL == 0) return (0, false);
        if (a.tSum == 0) return (spot, true);
        uint256 mean = a.wSum / a.tSum;
        return (mean > type(uint128).max ? type(uint128).max : uint128(mean), true);
    }

    // Sum the recorded steps into `a` until one ends the walk; true when none does.
    function _steps(bytes calldata r, uint256 h, int24 tc, Sum memory a) private pure returns (bool) {
        unchecked {
            bool up = h & UP != 0;
            uint256 n = (h >> 8) & 0xff;
            for (uint256 k; k < n; ++k) {
                if (!_step(_word(r, 2 + k), up, k == 0, tc, a)) return false;
            }
            return true;
        }
    }

    // One recorded step, line for line the walks' own (V3Depth._step, V4Depth._step) on its
    // recorded boundary and liquidity; false when the walk ends there. `first` is whether it is
    // the walk's first step, past which a downward span starts a compressed tick above a.pos
    // (V3Depth._step).
    function _step(uint256 s, bool up, bool first, int24 tc, Sum memory a) private pure returns (bool) {
        unchecked {
            int24 b = int24(uint24(s));
            bool init = s & (1 << 24) != 0;
            bool clip = up ? (b > tc) : (b <= tc);
            int256 from = up || first ? int256(a.pos) : int256(a.pos) + 1;
            int256 w = clip
                ? (up ? int256(tc) - from : from - int256(tc))
                : (up ? int256(b) - from : from - int256(b));
            if (w > 0) {
                a.wSum += uint256(a.liq) * uint256(w);
                a.tSum += uint256(w);
            }
            if (clip) return false; // reached the target
            if (init) {
                a.liq = uint128(s >> 32);
                if (a.liq == 0) return false; // liquidity exhausted
            }
            a.pos = up ? b : b - 1;
            return true;
        }
    }
}
