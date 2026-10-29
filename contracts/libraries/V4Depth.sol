// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { LibBit } from "solady/src/utils/LibBit.sol";
import { DepthRecord } from "./DepthRecord.sol";
import { V4Config } from "./V4Config.sol";
import { UniV4Lib } from "./UniV4Lib.sol";
import { InfinityLib } from "./InfinityLib.sol";

// Effective concentrated-liquidity depth for a singleton pool, V3Depth's counterpart. The
// walk is identical (the span-weighted mean of the active liquidity between this pool's
// price and a target, one step at a time, each to the next initialized tick or the end of a
// bitmap word); only the reads differ. A singleton pool's price, liquidity, ticks, and
// bitmap live in its manager, keyed by poolId, and its tick spacing comes from the registry,
// not a pool getter. Both Uniswap V4 (kind 4) and Pancake Infinity CL (kind 6) are read
// straight from their manager's storage with extsload.
// See V3Depth for the full rationale: a thin active tick beside deep liquidity must not
// read as shallow, because undersizing the restore leaves a residual dislocation the
// sandwich back-runs.
library V4Depth {
    uint8 private constant UNIV4 = 4;

    // The pool `id` of `kind` (Uniswap V4 or Pancake Infinity), whose ticks are `spacing` apart
    // and which is `flipped` when its currency order is the reverse of its pair's tokens. Also
    // returns the walk's record, as V3Depth does.
    // `dry` is for a route's hop, as V3Depth has it, and a walk that runs dry keeps where.
    function effectiveLiquidity(uint8 kind, bytes32 id, int24 spacing, bool flipped, uint160 targetSqrtP, uint256 maxTicks, bool dry)
        public
        view
        returns (uint128, bytes memory)
    {
        Acc memory a = _pool(kind, id);
        (a.dry, a.flipped) = (dry, flipped);
        uint160 curSqrt = _slot0(a); // a.pos: the pool's tick, until _begin compresses it
        a.liq = _liquidity(a);
        // The walk runs in the pool's currency space (the ticks and slot0 it reads).
        // VanHelsing passes the target in token space, so invert it for a flipped
        // (native) pool; liquidity is orientation-independent.
        if (flipped) targetSqrtP = V4Config.invertSqrt(targetSqrtP);
        if (maxTicks == 0 || targetSqrtP == curSqrt) return (a.liq, a.rec);
        (a.cur, a.target) = (curSqrt, targetSqrtP);

        bool up = targetSqrtP > curSqrt; // restore raises this pool's price
        int24 targetComp = _begin(a, (up ? DepthRecord.UP : 0) | (flipped ? DepthRecord.FLIPPED : 0) | (dry ? DepthRecord.DRY : 0), curSqrt, spacing, targetSqrtP);
        // A target in the price's own compressed tick: nothing the walk would read would count
        // (V3Depth).
        if (targetComp == a.pos) return (a.liq, a.rec);
        return (_walk(a, up, spacing, a.liq, maxTicks, targetComp), a.rec);
    }

    // The walk toward targetSqrtP replayed from the record of a walk toward a farther target on
    // the same state (DepthRecord.replay); false when the record does not cover it.
    function replay(bytes calldata record, uint160 targetSqrtP) public pure returns (uint128, bool) {
        return DepthRecord.replay(record, targetSqrtP);
    }

    // Where the pool a walk's record describes has traded `flow` wei of token1 (`one`) or token0
    // along its way, from any concentrated pool's record (DepthRecord.priceAfter).
    function priceAfter(bytes calldata record, uint256 flow, bool one) public pure returns (uint160, bool) {
        return DepthRecord.priceAfter(record, flow, one);
    }

    // What the pool a walk's record describes trades of token1 (`one`) or token0 from its price to
    // where its walk ran dry, from any concentrated pool's record (DepthRecord.tradedToCliff). Its
    // selector sorts after effectiveLiquidity's, which every V4 and Infinity walk calls, so the
    // dispatcher matches that one as early as before.
    function tradedToCliff(bytes calldata record, bool one) public pure returns (uint256) {
        return DepthRecord.tradedToCliff(record, one);
    }

    // Where the walk starts: the pool's tick and the target, compressed to spacing units, floored
    // toward -infinity, and the record's start. Returns the compressed target.
    function _begin(Acc memory a, uint256 flags, uint160 cur, int24 spacing, uint160 targetSqrtP)
        private
        pure
        returns (int24 targetComp)
    {
        a.pos = DepthRecord.compress(a.pos, spacing);
        targetComp = DepthRecord.compressedAt(targetSqrtP, spacing);
        a.rec = DepthRecord.start(flags, spacing, a.pos, targetComp, cur, a.liq);
    }

    // No bitmap word read yet: outside int16, so no word position equals it.
    int256 private constant NO_WORD = type(int256).max;

    // Mutable walk state and the pool it reads, held in one memory struct so the loop frame
    // stays small (these accumulators overflow the stack inline, and no viaIR). Passed by
    // reference to _step, which takes one step: to the next initialized tick or the end of a
    // bitmap word. `word` and `bits` keep the bitmap word read last: a walk reads the same word
    // step after step. `rec` notes every step.
    struct Acc {
        uint128 liq;
        uint256 wSum; // sum of L_span * width
        uint256 tSum; // sum of widths
        int24 pos;
        address manager; // Uniswap V4's PoolManager or Pancake Infinity's CLPoolManager
        uint256 state; // the pool's state slot in the manager
        int256 word;
        uint256 bits;
        bytes rec; // the walk's record (DepthRecord), none until it starts
        uint256 n; // the steps it took
        bool dry; // a route hop's walk: its depth at a cliff is DepthRecord.dryDepth
        bool flipped; // its currency order is the reverse of its pair's tokens
        bool dried; // it ran dry, its depth in dryL
        uint128 dryL;
        uint160 cur; // the price it walks from and the one it walks toward, in currency space
        uint160 target;
    }

    // The pool's manager and its state's slot there, worked out once: every read starts from them.
    function _pool(uint8 kind, bytes32 id) private pure returns (Acc memory a) {
        bool uni = kind == UNIV4;
        a.manager = uni ? address(UniV4Lib.POOL_MANAGER) : address(InfinityLib.CL);
        a.state = V4Config.mapSlot(id, uni ? V4Config.UNI_POOLS : V4Config.CL_POOLS);
        a.word = NO_WORD;
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
        // As V3Depth._walk: liquidity that comes back before the target, within the rest of the
        // gap's bitmap word or the next, is no cliff, whatever step the walk ran dry on.
        if (!a.dry && DepthRecord.cliffOf(a.rec) != 0 && _resumes(a, up, targetComp, 2)) {
            DepthRecord.noteCliff(a.rec, 0);
        }
        if (a.dried) return a.dryL;
        if (a.tSum == 0) return spot;
        uint256 mean = a.wSum / a.tSum;
        return mean > type(uint128).max ? type(uint128).max : uint128(mean);
    }

    // Whether an initialized tick lies past the boundary that left no liquidity (a.pos) and before
    // the target, within `budget` more steps (V3Depth._resumes).
    function _resumes(Acc memory a, bool up, int24 targetComp, uint256 budget) private view returns (bool) {
        unchecked {
            int24 pos = a.pos;
            for (uint256 k; k < budget; ++k) {
                (int24 b, bool init) = _nextInitialized(a, pos, up);
                if (up ? b > targetComp : b <= targetComp) return false;
                if (init) return true;
                pos = up ? b : b - 1;
            }
            return false;
        }
    }

    // A walk's end at compressed tick b, where crossing left no liquidity (V3Depth._ranDry): the
    // record keeps where, in token space, and a dry walk's depth is what the stretch before holds
    // of the way, in the pool's own space.
    function _ranDry(Acc memory a, bool up, int24 b, int24 spacing, uint128 before) private pure {
        (uint160 edge, uint160 cliff) = DepthRecord.edgeAt(b, spacing, a.flipped);
        DepthRecord.noteCliff(a.rec, cliff);
        if (!a.dry) return;
        a.dried = true;
        a.dryL = DepthRecord.dryDepth(a.tSum == 0 ? before : a.wSum / a.tSum, up, edge, a.cur, a.target);
    }

    // Unchecked as V3Depth's walk is. The spacing a tick read multiplies is the registry's, from
    // the pool's own key: a wrong one would misread the pool, as any wrong registry data would,
    // and a ward sized on it fails or captures less, never loses (VanHelsing is fundless).
    function _step(Acc memory a, bool up, int24 spacing, int24 targetComp) private view returns (bool) {
        unchecked {
            (int24 b, bool init) = _nextInitialized(a, a.pos, up);
            bool clip = up ? (b > targetComp) : (b <= targetComp);
            int256 from = up || a.n == 0 ? int256(a.pos) : int256(a.pos) + 1; // as V3Depth._step
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
            uint128 before = a.liq;
            if (init) {
                int128 net = _tickNet(a, int24(b * spacing));
                a.liq = _applyDelta(a.liq, up ? net : -net);
            }
            _note(a, b, init);
            a.pos = up ? b : b - 1; // advance strictly past the boundary
            if (init && a.liq == 0) {
                _ranDry(a, up, b, spacing, before);
                return false; // liquidity exhausted
            }
            return true;
        }
    }

    // --- reads, one storage slot each through the manager's extsload ---

    // The pool's price, and its tick into a.pos.
    function _slot0(Acc memory a) private view returns (uint160 sqrtP) {
        uint256 w = V4Config.load(a.manager, a.state);
        sqrtP = uint160(w);
        a.pos = int24(int256(w >> 160));
    }

    function _liquidity(Acc memory a) private view returns (uint128) {
        unchecked {
            return uint128(V4Config.load(a.manager, a.state + V4Config.LIQUIDITY_OFFSET));
        }
    }

    // A tick's net liquidity, the upper half of the first slot of its info (Infinity's getter
    // returns the whole struct: two more slots, cold and unused).
    function _tickNet(Acc memory a, int24 tick) private view returns (int128) {
        unchecked {
            return int128(int256(V4Config.load(a.manager, V4Config.mapSlot(bytes32(uint256(int256(tick))), a.state + V4Config.TICKS_OFFSET)) >> 128));
        }
    }

    // A bitmap word, from the walk's last read when it is the same word.
    function _bitmap(Acc memory a, int16 wordPos) private view returns (uint256 bits) {
        if (a.word == wordPos) return a.bits;
        unchecked {
            bits = V4Config.load(a.manager, V4Config.mapSlot(bytes32(uint256(int256(wordPos))), a.state + V4Config.TICK_BITMAP_OFFSET));
        }
        (a.word, a.bits) = (wordPos, bits);
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
    // and above it going up, within one bitmap word, as V3Depth finds it (after Uniswap
    // v4-core's TickBitmap, Copyright 2023 Universal Navigation Inc., MIT License).
    function _nextInitialized(Acc memory a, int24 comp, bool up)
        private
        view
        returns (int24 next, bool init)
    {
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

    // TickBitmap.position on the compressed tick, as V3Depth has it.
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
}
