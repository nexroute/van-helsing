// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { LibBit } from "solady/src/utils/LibBit.sol";
import { DepthRecord } from "./DepthRecord.sol";

// Effective concentrated-liquidity depth for sizing a restore.
//
// A V3 pool's liquidity() is the ACTIVE tick's liquidity only. When a front-run
// pushes the price into a sparse tick, or the active tick is just thin next to a
// deep neighbor, liquidity() reads far below the depth the restore actually draws
// on. Feeding that thin value to MeetingPrice mis-sizes the restore, and the error
// costs either way it lands: too small leaves a residual dislocation the attacker
// back-runs; too large drives the swap-to-limit past what the other pool can absorb
// and reverts (the ward does nothing) or overshoots and opens a fresh dislocation.
// Underestimating OR overestimating any concentrated leg is unsafe, so the aim is
// accuracy, not a one-sided bias.
//
// effectiveLiquidity walks up to `maxTicks` steps from the pool's own price toward
// `targetSqrtP` (in sizing's first pass, the OTHER pool's price: the outer bound of any
// meeting point, and independent of the possibly-corrupt spot liquidity), applying each
// crossed tick's liquidityNet, and returns the span-weighted-mean liquidity over that
// region. That single L characterizes the pool's response over the stretch the restore
// trades through, so a thin active tick beside a deep range does not read as shallow, nor
// a deep active tick beside a cliff as deep. It stays a within-region linearization (the
// same assumption MeetingPrice makes), not a tick-by-tick swap simulation; the maxTicks
// cap bounds gas, and a walk that reaches it averages over the stretch it covered.
// Uniswap V3-shaped pools only.
library V3Depth {
    // Walk toward `targetSqrtP`, span-weighting each tick span's liquidity by its width, and
    // return the mean. Returns spot liquidity when
    // the target equals the current price, the budget is zero, or no initialized tick
    // is found in range (a uniform/deep pool, where spot L is already right). Also returns
    // the walk's record, from which a walk toward a nearer target is replayed (DepthRecord).
    function effectiveLiquidity(address pool, uint160 targetSqrtP, uint256 maxTicks)
        public
        view
        returns (uint128, bytes memory)
    {
        Acc memory a;
        (a.pool, a.word) = (pool, NO_WORD);
        uint160 curSqrt = _slot0(a); // a.pos: the pool's tick, until _begin compresses it
        a.liq = _liquidity(pool);
        if (maxTicks == 0 || targetSqrtP == curSqrt) return (a.liq, a.rec);

        int24 spacing = _tickSpacing(pool);
        bool up = targetSqrtP > curSqrt; // restore raises this pool's price
        int24 targetComp = _begin(a, up, curSqrt, spacing, targetSqrtP);
        // A target in the price's own compressed tick: the first boundary the walk finds
        // either way is past it, so it would clip there at width 0, and nothing it reads
        // would count.
        if (targetComp == a.pos) return (a.liq, a.rec);
        return (_walk(a, up, spacing, a.liq, maxTicks, targetComp), a.rec);
    }

    // Where the walk starts: the pool's tick and the target, compressed to spacing units, floored
    // toward -infinity, and the record's start. Returns the compressed target.
    function _begin(Acc memory a, bool up, uint160 cur, int24 spacing, uint160 targetSqrtP)
        private
        pure
        returns (int24 targetComp)
    {
        a.pos = DepthRecord.compress(a.pos, spacing);
        targetComp = DepthRecord.compressedAt(targetSqrtP, spacing);
        a.rec = DepthRecord.start(up ? DepthRecord.UP : 0, spacing, a.pos, targetComp, cur, a.liq);
    }

    // The walk toward targetSqrtP replayed from the record of a walk toward a farther target on
    // the same state (DepthRecord.replay); false when the record does not cover it.
    function replay(bytes calldata record, uint160 targetSqrtP) public pure returns (uint128, bool) {
        return DepthRecord.replay(record, targetSqrtP);
    }

    // No bitmap word read yet: outside int16, so no word position equals it.
    int256 private constant NO_WORD = type(int256).max;

    // Mutable walk state and the pool it reads, held in one memory struct so the loop frame
    // stays small (no viaIR). `word` and `bits` keep the bitmap word read last: a walk reads
    // the same word step after step until it crosses into the next. `rec` notes every step.
    struct Acc {
        uint128 liq;
        uint256 wSum; // sum of L_span * width
        uint256 tSum; // sum of widths
        int24 pos;
        address pool;
        int256 word;
        uint256 bits;
        bytes rec; // the walk's record (DepthRecord), none until it starts
        uint256 n; // the steps it took
    }

    function _walk(Acc memory a, bool up, int24 spacing, uint128 spot, uint256 maxTicks, int24 targetComp)
        private
        view
        returns (uint128)
    {
        uint256 i;
        for (; i < maxTicks;) {
            if (!_step(a, up, spacing, targetComp)) break; // exhausted or reached target
            unchecked { ++i; }
        }
        DepthRecord.finish(a.rec, a.n, i == maxTicks);
        if (a.tSum == 0) return spot;
        uint256 mean = a.wSum / a.tSum;
        return mean > type(uint128).max ? type(uint128).max : uint128(mean);
    }

    // One span. Every quantity stays far inside its type for any real pool (ticks within
    // int24, the weighted sums under 2^150), so it skips the overflow checks. A tick read is a
    // bit of the pool's own bitmap times the pool's own spacing: a real tick.
    function _step(Acc memory a, bool up, int24 spacing, int24 targetComp) private view returns (bool) {
        unchecked {
            (int24 b, bool init) = _nextInitialized(a, a.pos, up);
            // Clip the run at the target: if the next boundary is past targetComp, or at it going
            // down, add only the width up to targetComp and stop (the restore never reaches `b`).
            bool clip = up ? (b > targetComp) : (b <= targetComp);
            // The span starts where the walk stands: at the price's compressed tick (a.pos) until
            // the first step, then at the boundary the last step reached, which going down is a
            // compressed tick above a.pos, where the next search starts.
            int256 from = up || a.n == 0 ? int256(a.pos) : int256(a.pos) + 1;
            int256 w = clip
                ? (up ? int256(targetComp) - from : from - int256(targetComp))
                : (up ? int256(b) - from : from - int256(b));
            if (w > 0) {
                a.wSum += uint256(a.liq) * uint256(w);
                a.tSum += uint256(w);
            }
            if (clip) {
                _note(a, b, init);
                return false; // reached the target
            }
            if (init) {
                int128 net = _tickNet(a.pool, int24(b * spacing));
                a.liq = _applyDelta(a.liq, up ? net : -net);
            }
            _note(a, b, init);
            if (init && a.liq == 0) return false; // liquidity exhausted
            a.pos = up ? b : b - 1;
            return true;
        }
    }

    // Note a step the walk took, with the liquidity once it is done: past its boundary, or
    // before it on the step that stops at the target.
    function _note(Acc memory a, int24 b, bool init) private pure {
        unchecked {
            uint256 n = a.n;
            DepthRecord.note(a.rec, n, b, init, a.liq);
            a.n = n + 1;
        }
    }

    // Next initialized tick (compressed) in the walk direction, at or below `comp` going down
    // and above it going up, searched within one bitmap word, as Uniswap v4-core's TickBitmap
    // (Copyright 2023 Universal Navigation Inc., MIT License) does it. When the word holds none,
    // returns its far edge with init=false so the walk advances.
    function _nextInitialized(Acc memory a, int24 comp, bool up) private view returns (int24 next, bool init) {
        unchecked {
            if (!up) {
                (int16 wordPos, uint8 bitPos) = _position(comp);
                uint256 mask = (uint256(1) << bitPos) - 1 + (uint256(1) << bitPos); // bits <= bitPos
                uint256 masked = _bitmap(a, wordPos) & mask;
                init = masked != 0;
                next = init
                    ? comp - int24(uint24(bitPos - uint8(LibBit.fls(masked))))
                    : comp - int24(uint24(bitPos));
            } else {
                (int16 wordPos, uint8 bitPos) = _position(comp + 1);
                uint256 mask = ~((uint256(1) << bitPos) - 1); // bits >= bitPos
                uint256 masked = _bitmap(a, wordPos) & mask;
                init = masked != 0;
                next = init
                    ? comp + 1 + int24(uint24(uint8(LibBit.ffs(masked)) - bitPos))
                    : comp + 1 + int24(uint24(type(uint8).max - bitPos));
            }
        }
    }

    // TickBitmap.position on the compressed tick, as in Uniswap v4-core (Copyright 2023
    // Universal Navigation Inc., MIT License).
    function _position(int24 compressed) private pure returns (int16 wordPos, uint8 bitPos) {
        wordPos = int16(compressed >> 8);
        bitPos = uint8(int8(compressed % 256));
    }

    // Apply a signed liquidityNet, saturating instead of reverting: no pool's liquidity can make
    // a depth read take down the ward.
    function _applyDelta(uint128 x, int128 y) private pure returns (uint128) {
        unchecked {
            if (y < 0) {
                uint128 dec = uint128(-y);
                return dec > x ? 0 : x - dec;
            }
            uint256 r = uint256(x) + uint256(uint128(y));
            return r > type(uint128).max ? type(uint128).max : uint128(r);
        }
    }

    // --- reads: plain staticcalls to the pool's getters, taking the leading words a
    // real pool returns (slot0 and ticks return more, which these leave unread) ---

    // The pool's price, and its tick into a.pos.
    function _slot0(Acc memory a) private view returns (uint160 s) {
        address pool = a.pool;
        int24 tick;
        assembly ("memory-safe") {
            mstore(0, 0x3850c7bd) // slot0()
            if iszero(and(gt(returndatasize(), 0x3f), staticcall(gas(), pool, 0x1c, 0x04, 0, 0x40))) { revert(0, 0) }
            s := and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            tick := signextend(2, mload(0x20))
        }
        a.pos = tick;
    }

    function _liquidity(address pool) private view returns (uint128 l) {
        assembly ("memory-safe") {
            mstore(0, 0x1a686502) // liquidity()
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), pool, 0x1c, 0x04, 0, 0x20))) { revert(0, 0) }
            l := and(mload(0), 0xffffffffffffffffffffffffffffffff)
        }
    }

    function _tickSpacing(address pool) private view returns (int24 spacing) {
        assembly ("memory-safe") {
            mstore(0, 0xd0c93a7c) // tickSpacing()
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), pool, 0x1c, 0x04, 0, 0x20))) { revert(0, 0) }
            spacing := signextend(2, mload(0))
        }
    }

    // A tick's liquidityNet, the second word of ticks(tick).
    function _tickNet(address pool, int24 tick) private view returns (int128 net) {
        assembly ("memory-safe") {
            mstore(0, 0xf30dba93) // ticks(int24)
            mstore(0x20, signextend(2, tick))
            if iszero(and(gt(returndatasize(), 0x3f), staticcall(gas(), pool, 0x1c, 0x24, 0, 0x40))) { revert(0, 0) }
            net := signextend(15, mload(0x20))
        }
    }

    // A bitmap word, from the walk's last read when it is the same word.
    function _bitmap(Acc memory a, int16 wordPos) private view returns (uint256 bits) {
        if (a.word == wordPos) return a.bits;
        address pool = a.pool;
        assembly ("memory-safe") {
            mstore(0, 0x5339c296) // tickBitmap(int16)
            mstore(0x20, signextend(1, wordPos))
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), pool, 0x1c, 0x24, 0, 0x20))) { revert(0, 0) }
            bits := mload(0)
        }
        (a.word, a.bits) = (wordPos, bits);
    }
}
