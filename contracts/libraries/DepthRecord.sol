// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
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
// currency space (1), its direction there, up (2), whether it ended on its step budget (3),
// whether it counts the way past the pool's last liquidity at zero (4, dry), the steps it took (8-15), the spacing (16-39), the compressed tick it started from (40-63) and
// the compressed target it walked toward (64-87), and the price it started from (96-255). The
// second: the active liquidity it started with. Then each step: the compressed boundary it
// reached (an int24, bits 0-23), whether that is an initialized tick (24), and the liquidity
// once the step is done (32-159): past the boundary, or before it on the step that stops at
// the target. The last word: where the walk ran dry, the sqrt price of the tick whose crossing
// left no liquidity, in token space (0 when it did not run dry). A walk that ends before it
// starts (no step budget, or its target at its price) returns no record.
library DepthRecord {
    // The steps a record holds: as many as VanHelsing lets a walk take (MAX_DEPTH_TICKS).
    uint256 internal constant STEPS = 8;
    uint256 internal constant WORDS = STEPS + 3;
    // The last word's offset in a record's memory, past its length word: WORDS * 32, as a number
    // inline assembly takes.
    uint256 private constant LAST = 352;

    uint256 internal constant OK = 1;
    uint256 internal constant FLIPPED = 2;
    uint256 internal constant UP = 4;
    uint256 internal constant FULL = 8;
    // A walk for a route's hop: when crossing a tick leaves no liquidity, its depth is what the
    // stretch before holds of the way to its target (dryDepth), so a hop whose liquidity ends near
    // its price does not read as deep as that stretch.
    uint256 internal constant DRY = 16;

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

    // The sqrt price of compressed tick b's boundary, where crossing it left a walk no liquidity:
    // in the pool's own currency space (`edge`, what dryDepth takes) and in token space (`cliff`,
    // what a record keeps), the inverse for a flipped pool.
    function edgeAt(int24 b, int24 spacing, bool flipped) internal pure returns (uint160 edge, uint160 cliff) {
        edge = TickMath.getSqrtPriceAtTick(int24(int256(b) * int256(spacing)));
        cliff = flipped ? V4Config.invertSqrt(edge) : edge;
    }

    // Keep where the walk ran dry (token space) in its record's last word.
    function noteCliff(bytes memory r, uint160 cliff) internal pure {
        assembly ("memory-safe") {
            mstore(add(r, LAST), cliff)
        }
    }

    // Where the walk a record holds ran dry, in token space; 0 when it did not, or for no record.
    // A record is WORDS words long, LAST bytes, its last word at offset LAST.
    function cliffOf(bytes memory r) internal pure returns (uint160 c) {
        assembly ("memory-safe") {
            if eq(mload(r), LAST) { c := mload(add(r, LAST)) }
        }
    }

    // Word k of a record handed back as calldata.
    function _word(bytes calldata r, uint256 k) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := calldataload(add(r.offset, mul(k, 0x20)))
        }
    }

    // A pool's way, read from its walk's record: where it is (`p`, sqrt price in its own currency
    // space), its liquidity there (`l`), what it has yet to trade (`rest`, wei), of which token in
    // its own space (`one`: currency1), and which way it moves (`up`).
    struct Way {
        uint256 p;
        uint256 l;
        uint256 rest;
        bool one;
        bool up;
    }

    // The sqrt price, in token space, at which the pool a record describes has traded `flow` wei of
    // token1 (`one`) or token0 from its price along its walk's way: span by span to each recorded
    // boundary, at the liquidity the walk read there, then on at the liquidity it ended with. Each
    // span's amount is rounded up and the move inside the last one toward its start, so by the price
    // returned the pool trades at most `flow`. `ok` is false for a record that holds no walk; the
    // price is 0 when the way runs out of liquidity first, or `flow` is past any pool's.
    function priceAfter(bytes calldata r, uint256 flow, bool one) internal pure returns (uint160 price, bool ok) {
        if (r.length != WORDS * 32) return (0, false);
        uint256 h = _word(r, 0);
        if (h & OK == 0) return (0, false);
        if (flow >> 128 != 0) return (0, true);
        // In a flipped pool's own space the pair's token1 is its currency0.
        Way memory w = Way(uint160(h >> 96), _word(r, 1), flow, one != (h & FLIPPED != 0), h & UP != 0);
        int24 spacing = int24(uint24(h >> 16));
        uint256 n = (h >> 8) & 0xff;
        bool done;
        for (uint256 k; k < n && !done; ++k) {
            uint256 s = _word(r, 2 + k);
            // Only an initialized tick changes the liquidity: a step to a word's end goes on.
            if (s & (1 << 24) == 0) continue;
            uint256 edge = TickMath.getSqrtPriceAtTick(int24(int256(int24(uint24(s))) * spacing));
            // A span without liquidity, as from a price past a pool's last position, is crossed
            // without trading.
            if (w.l == 0) w.p = edge;
            else done = _span(w, edge);
            w.l = uint128(s >> 32);
        }
        if (!done) {
            if (w.l == 0) return (0, true);
            w.p = _move(w);
        }
        price = uint160(w.p);
        if (h & FLIPPED != 0) price = V4Config.invertSqrt(price);
        ok = true;
    }

    // What the pool a record describes trades from its price to where its walk ran dry, in whole
    // wei of token1 (`one`) or token0: span by span to each recorded boundary, at the liquidity the
    // walk read there, each span rounded down as a pool pays it, L * (hi - lo) / 2^96 and
    // L * 2^96 * (1/lo - 1/hi). Pools round what they are owed up, so a sink sized to this lands
    // short of its cliff. 0 for a record that holds no walk, or a walk that did not run dry.
    function tradedToCliff(bytes calldata r, bool one) internal pure returns (uint256 c) {
        if (r.length != WORDS * 32) return 0;
        uint256 h = _word(r, 0);
        if (h & OK == 0) return 0;
        // In a flipped pool's own space the pair's token1 is its currency0.
        bool o = one != (h & FLIPPED != 0);
        uint256 p = uint160(h >> 96);
        uint256 l = _word(r, 1);
        int24 spacing = int24(uint24(h >> 16));
        uint256 n = (h >> 8) & 0xff;
        for (uint256 k; k < n; ++k) {
            uint256 s = _word(r, 2 + k);
            if (s & (1 << 24) == 0) continue;
            uint256 edge = TickMath.getSqrtPriceAtTick(int24(int256(int24(uint24(s))) * spacing));
            (uint256 hi, uint256 lo) = edge > p ? (edge, p) : (p, edge);
            c += o
                ? FixedPointMathLib.fullMulDiv(l, hi - lo, 1 << 96)
                : FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(l, hi - lo, hi), 1 << 96, lo);
            l = uint128(s >> 32);
            p = edge;
            if (l == 0) return c;
        }
        return 0;
    }

    // One span of the way, from w.p to `edge` at w.l: true when the rest is traded inside it, w.p
    // then where; else the span's amount off the rest and w.p at the edge.
    function _span(Way memory w, uint256 edge) private pure returns (bool) {
        (uint256 hi, uint256 lo) = edge > w.p ? (edge, w.p) : (w.p, edge);
        uint256 c = w.one
            ? FixedPointMathLib.fullMulDivUp(w.l, hi - lo, 1 << 96)
            : FixedPointMathLib.fullMulDivUp(FixedPointMathLib.fullMulDivUp(w.l, 1 << 96, lo), hi - lo, hi);
        if (c >= w.rest) {
            w.p = _move(w);
            return true;
        }
        w.rest -= c;
        w.p = edge;
        return false;
    }

    // Where a pool at w.p of liquidity w.l is once it has traded w.rest, rounded toward w.p:
    // currency1 moves the sqrt price by rest * 2^96 / L, currency0 its inverse by rest / (L * 2^96).
    function _move(Way memory w) private pure returns (uint256) {
        if (w.one) {
            uint256 d = FixedPointMathLib.fullMulDiv(w.rest, 1 << 96, w.l);
            if (w.up) return w.p + d > TickMath.MAX_SQRT_PRICE ? TickMath.MAX_SQRT_PRICE : w.p + d;
            return d >= w.p - TickMath.MIN_SQRT_PRICE ? TickMath.MIN_SQRT_PRICE : w.p - d;
        }
        uint256 t = FixedPointMathLib.fullMulDiv(w.rest, w.p, 1 << 96);
        if (!w.up) return FixedPointMathLib.fullMulDivUp(w.p, w.l, w.l + t);
        if (t >= w.l) return TickMath.MAX_SQRT_PRICE;
        uint256 up = FixedPointMathLib.fullMulDiv(w.p, w.l, w.l - t);
        return up > TickMath.MAX_SQRT_PRICE ? TickMath.MAX_SQRT_PRICE : up;
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
        return _sum(r, h, pos, tc, targetSqrtP);
    }

    // The replay's running sums, as the walk keeps them, and what a dry walk's end needs: the
    // spacing, the price the walk started from and the target it is replayed toward.
    struct Sum {
        uint128 liq;
        int24 pos;
        uint256 wSum; // sum of L_span * width
        uint256 tSum; // sum of widths
        int24 spacing;
        uint160 cur;
        uint160 target;
        bool dried; // ran dry, its depth in dryL
        uint128 dryL;
    }

    // The span-weighted mean over the recorded steps, clipped at tc, as the walk sums it.
    function _sum(bytes calldata r, uint256 h, int24 pos, int24 tc, uint160 targetSqrtP) private pure returns (uint128, bool) {
        uint128 spot = uint128(_word(r, 1));
        Sum memory a = Sum(spot, pos, 0, 0, int24(uint24(h >> 16)), uint160(h >> 96), targetSqrtP, false, 0);
        // Past the recorded steps without clipping or running dry, only the step budget ends the
        // walk, and only when the first walk ended on it too.
        if (_steps(r, h, tc, a) && h & FULL == 0) return (0, false);
        if (a.dried) return (a.dryL, true);
        if (a.tSum == 0) return (spot, true);
        uint256 mean = a.wSum / a.tSum;
        return (mean > type(uint128).max ? type(uint128).max : uint128(mean), true);
    }

    // Sum the recorded steps into `a` until one ends the walk; true when none does.
    function _steps(bytes calldata r, uint256 h, int24 tc, Sum memory a) private pure returns (bool) {
        unchecked {
            bool up = h & UP != 0;
            bool dry = h & DRY != 0;
            uint256 n = (h >> 8) & 0xff;
            for (uint256 k; k < n; ++k) {
                if (!_step(_word(r, 2 + k), up, k == 0, dry, tc, a)) return false;
            }
            return true;
        }
    }

    // One recorded step, line for line the walks' own (V3Depth._step, V4Depth._step) on its
    // recorded boundary and liquidity; false when the walk ends there. `first` is whether it is
    // the walk's first step, past which a downward span starts a compressed tick above a.pos
    // (V3Depth._step); `dry` whether the walk counts the way past its last liquidity at zero.
    function _step(uint256 s, bool up, bool first, bool dry, int24 tc, Sum memory a) private pure returns (bool) {
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
                uint128 before = a.liq;
                a.liq = uint128(s >> 32);
                if (a.liq == 0) {
                    if (dry) {
                        (uint160 edge,) = edgeAt(b, a.spacing, false);
                        (a.dried, a.dryL) = (true, dryDepth(a.tSum == 0 ? before : a.wSum / a.tSum, up, edge, a.cur, a.target));
                    }
                    return false; // liquidity exhausted
                }
            }
            a.pos = up ? b : b - 1;
            return true;
        }
    }

    // A dry walk's depth once crossing the tick at sqrt price `edge` left no liquidity: `mean`, the
    // liquidity of the stretch before it, times the share of the way from the price `cur` to
    // `target` that stretch holds, in the sqrt price a restore is sized in (all three in the pool's
    // own space). Going up a pool takes token1 in, L * (edge - cur) of it, so the share is (edge -
    // cur) / (target - cur); going down it takes token0, L * (1/edge - 1/cur), the same share in
    // 1/sqrt. Exact for a pool whose liquidity ends at edge, wherever its price sits in its tick; a
    // stretch of several spans keeps their tick-weighted mean. The walk never reaches edge past its
    // target, so the share is at most one.
    function dryDepth(uint256 mean, bool up, uint256 edge, uint160 cur, uint160 target)
        internal
        pure
        returns (uint128)
    {
        uint256 d;
        if (up) {
            if (edge <= cur || target <= cur) return 0;
            d = FixedPointMathLib.fullMulDiv(mean, edge - cur, uint256(target) - cur);
        } else {
            if (edge >= cur || target >= cur) return 0;
            d = FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(mean, cur - edge, uint256(cur) - target), target, edge);
        }
        return d > type(uint128).max ? type(uint128).max : uint128(d);
    }
}
