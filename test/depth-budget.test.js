import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// How the depth walk's read depends on its step budget, and what that does to a restore.
//
// V3Depth/V4Depth.effectiveLiquidity walks from the pool's price toward a target, at most
// `maxTicks` steps (VanHelsing passes 8), each to the next initialized tick or to the end
// of a bitmap word, and stops at the target or where the liquidity runs out. It returns
// the span-weighted mean liquidity over what it covered. Toward a far target (the MIN_SQRT
// or MAX_SQRT the profiles below walk toward) nothing clips, so the budget, unless the
// liquidity runs out first, decides how far out the read reaches: the 1-step read is the
// depth at the pool's price, the 8-step read averages in what lies past it. On a pool
// deep at its price and thin farther out (a cliffy pool) the 8-step read falls far below
// the 1-step one; on a uniform pool the two agree.
//
// Part A builds those shapes on a MockV3TickPool and compares the restore a defended pool
// gets when its anchor is read at 1 step (bounded near the anchor's price) and at 8 steps.
// Part B reads real V4 and V3 hops on a fork the same way, then measures sizing's pass 1
// (the anchor walked toward the defended pool's price) against the true bound (walked to
// its own meeting price, iterated to a fixed point), and checks that VanHelsing's pass 2
// lands between the two.
//
// The metric is the RESTORE FRACTION: how far the defended pool is driven back toward the
// anchor's price (the residual dislocation is what an attacker back-runs). More restore ==
// better defense.

const Q96 = 1n << 96n;
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const CAKE_USDT_V3 = "0x7f51c8aaa6b0599abd16674e2b17fec7a9f674a1"; // a V3 CAKE/USDT pool, fee 2500
const BLOCK = 103808000;

const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

// down-restore fraction of the defended leg: how far sdFinal moved from sd toward sa.
function restoreFrac(sd, sdFinal, sa) {
    if (sd === sa) return 0;
    // scaled to 1e6 for readable integer percent
    const num = (sd - sdFinal) * 1_000_000n;
    return num / (sd - sa);
}

describe("Depth walk step budget (measurement)", function () {
    // Part A: controlled cliffy anchor, fully deterministic, no fork
    describe("A: controlled cliffy anchor vs defended pool", function () {
        let conn, ethers, v3d, mp;

        before(async function () {
            conn = await network.create({ network: "hardhat" });
            ethers = conn.ethers;
            v3d = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
            mp = await deploy(conn, "MeetingPriceHarness");
        });

        // deep core over [-coreComp, +coreComp] with liquidity D, thin skirt over
        // [-skirtComp, +skirtComp] with liquidity T. spot (tick 0) sees D+T. spacing 10.
        async function buildCliffy(D, T, coreComp, skirtComp) {
            const t0 = "0x1111111111111111111111111111111111111111";
            const t1 = "0x2222222222222222222222222222222222222222";
            const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D + T, 10, t0, t1]);
            const core = BigInt(coreComp) * 10n, skirt = BigInt(skirtComp) * 10n;
            await pool.setTick(-Number(skirt), T);
            await pool.setTick(-Number(core), D);
            await pool.setTick(Number(core), -D);
            await pool.setTick(Number(skirt), -T);
            return pool;
        }

        async function profile(pool, label) {
            const rows = [];
            for (const mt of [1, 2, 3, 4, 6, 8]) {
                const l = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, mt);
                rows.push(`maxTicks=${mt}: L=${l}`);
            }
            console.log(`  [${label}] effective L walking up:\n    ${rows.join("\n    ")}`);
            const near = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 1);
            const cur = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 8);
            console.log(`  [${label}] near-spot (mt=1) / 8-step (mt=8) under-read factor = ${Number(near) / Number(cur)}x`);
            return { near, cur };
        }

        // restore fraction of a defended pool at sd (skewed high) with liquidity Ld,
        // against an anchor at sa=1.0 with liquidity La. Fee-free (isolate L).
        async function restore(sd, ld, sa, la) {
            const [sdF] = await mp.meetBoth(sd, ld, 1, 1, sa, la, 1, 1);
            return restoreFrac(sd, sdF, sa);
        }

        it("STRONG cliff: toward a far target, the 8-step read falls far below the 1-step depth at the price", async function () {
            const D = 10n ** 24n, T = 10n ** 20n;
            const pool = await buildCliffy(D, T, 10, 200); // deep core +-1%, thin skirt to +-20%
            const { near, cur } = await profile(pool, "strong-cliff");
            expect(Number(near) / Number(cur)).to.be.gt(3); // real under-read, not noise
        });

        it("CAPTURE TABLE: an 8-step under-read of the anchor shrinks the restore a bounded read gives", async function () {
            const D = 10n ** 24n, T = 10n ** 20n;
            const pool = await buildCliffy(D, T, 10, 200);
            const near = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 1); // ~1e24
            const cur = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 8); // ~5e22

            const sa = Q96; // anchor fair price 1.0
            const sd = (Q96 * 105n) / 100n; // defended skewed ~+10% (sqrt 1.05 => price ~1.1)

            // Ld chosen to sit BETWEEN the 8-step read and the near-spot read, the regime
            // where the under-read matters: with the true (near-spot) depth the anchor is
            // deeper than the defended (big restore); with the 8-step read it looks
            // shallower (tiny restore).
            for (const ld of [cur * 2n, (cur + near) / 2n, near / 2n]) {
                const fCur = await restore(sd, ld, sa, cur);
                const fNear = await restore(sd, ld, sa, near);
                console.log(
                    `  Ld=${ld}: restore 8-step(La=${cur})=${Number(fCur) / 1e4}%  ` +
                    `bounded(La=${near})=${Number(fNear) / 1e4}%  recovery=${Number(fNear) / Number(fCur)}x`,
                );
                expect(fNear).to.be.gte(fCur); // bounding never restores LESS
            }
        });

        it("CONTROL uniform anchor: no cliff => flat profile => no capture gap", async function () {
            // one wide deep position, no skirt: L is constant across the walk
            const D = 10n ** 24n;
            const t0 = "0x1111111111111111111111111111111111111111";
            const t1 = "0x2222222222222222222222222222222222222222";
            const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D, 10, t0, t1]);
            await pool.setTick(-2000, D);
            await pool.setTick(2000, -D);
            const near = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 1);
            const cur = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 8);
            console.log(`  [uniform] near=${near} 8-step=${cur} under-read=${Number(near) / Number(cur)}x (expect ~1)`);
            expect(near).to.equal(cur); // flat: no gap to recover
        });

        it("CONTROL deep defended pool: the restore stays small however the anchor is read", async function () {
            // The DEFENDED pool is ~100x deeper than the anchor's near-spot depth, so the
            // anchor moves and the defended pool barely does: the restore is small however
            // the anchor is read, an effect of the depth ratio rather than of the walk.
            const D = 10n ** 24n, T = 10n ** 20n;
            const pool = await buildCliffy(D, T, 10, 200);
            const near = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 1);
            const cur = await v3d.effectiveLiquidity(await pool.getAddress(), MAX_SQRT, 8);
            const sa = Q96, sd = (Q96 * 105n) / 100n;
            const ldDeep = 10n ** 26n; // defended ~100x deeper than the anchor's near-spot
            const fCur = await restore(sd, ldDeep, sa, cur);
            const fNear = await restore(sd, ldDeep, sa, near);
            console.log(`  [deep defended] Ld=${ldDeep}: restore 8-step=${Number(fCur) / 1e4}% bounded=${Number(fNear) / 1e4}% (both small: the depth ratio, not the walk)`);
            expect(fNear).to.be.lt(50_000); // < 5%: a small restore here is the depth ratio, not a walk effect
        });
    });

    // Part B: do REAL BSC pools have the cliffy shape where the step budget matters?
    describeFork("B: real-pool depth profiles on a fork", function () {
        let conn, ethers, v3d, v4d, v4reader, mp;

        before(async function () {
            this.timeout(180000);
            conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
            ethers = conn.ethers;
            v3d = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
            v4d = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
            v4reader = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
            mp = await deploy(conn, "MeetingPriceHarness");
        });

        it("real V4 USDT/WBNB hop: effective L vs maxTicks, both directions", async function () {
            const cfg = configV4([4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]);
            for (const [dir, tgt] of [["up(MAX)", MAX_SQRT], ["down(MIN)", MIN_SQRT]]) {
                const rows = [];
                for (const mt of [1, 2, 3, 4, 6, 8]) rows.push(`mt=${mt}:${await v4d.effectiveLiquidity(cfg, tgt, mt)}`);
                const near = await v4d.effectiveLiquidity(cfg, tgt, 1);
                const cur = await v4d.effectiveLiquidity(cfg, tgt, 8);
                console.log(`  [V4 USDT/WBNB ${dir}] ${rows.join("  ")}\n    under-read(near/8-step)=${Number(near) / Number(cur)}x`);
            }
        });

        it("real V3 CAKE/USDT hop: effective L vs maxTicks, both directions", async function () {
            for (const [dir, tgt] of [["up(MAX)", MAX_SQRT], ["down(MIN)", MIN_SQRT]]) {
                const rows = [];
                for (const mt of [1, 2, 3, 4, 6, 8]) rows.push(`mt=${mt}:${await v3d.effectiveLiquidity(CAKE_USDT_V3, tgt, mt)}`);
                const near = await v3d.effectiveLiquidity(CAKE_USDT_V3, tgt, 1);
                const cur = await v3d.effectiveLiquidity(CAKE_USDT_V3, tgt, 8);
                console.log(`  [V3 CAKE/USDT ${dir}] ${rows.join("  ")}\n    under-read(near/8-step)=${Number(near) / Number(cur)}x`);
            }
        });

        // Pass 1 vs the true bound, and where pass 2 lands between them.
        //
        // Pass 1 sizes each leg by bounding its walk at the OTHER pool's CURRENT price:
        // VanHelsing._meet walks the defended pool toward sa and the anchor toward sd
        // (_legLiq), then meets them. That bound is a conservative superset of the true
        // restore range: a leg never restores past the other pool's current price, so
        // [spot, ownMeet] is a subset of [spot, otherPrice]. The TRUE bound is each
        // leg's OWN meeting price, which depends on L, which depends on the bound
        // (chicken-and-egg), so it is found here by iterating the walk to a fixed point
        // in JS. VanHelsing's pass 2 takes one step of that iteration on-chain: it
        // re-walks each concentrated leg at its own pass-1 meeting price (_pass2).
        //
        // Per case, a synthetic "defended" counter-price/liquidity (sd, ldDef) is held
        // fixed, and the pool under test (real V4 pool, cliffy mock, or a uniform
        // control) supplies the other side (sa, la), read two ways: L_pass1 =
        // effectiveLiquidity(pool, sd, 8) (the real pass-1 target, at VanHelsing's
        // maxTicks of 8) and L_true = the converged iterate. Both are fed into
        // MeetingPriceHarness.meetBoth (fee-free: nd=dd=na=da=1, isolating L) to get a
        // restore fraction (MeetingPrice.target: restoreFrac = la/(la+ld) in the
        // down-restore case used throughout, sd > sa). ldDef is the geometric mean of
        // the pool's spot liquidity and its L_pass1 read, straddling the two by
        // construction: the regime where the choice of L actually swings the restore.
        const summary = [];

        // integer sqrt (Newton's method) for BigInt.
        function bigintSqrt(n) {
            if (n < 2n) return n;
            let x = n, y = (x + 1n) / 2n;
            while (y < x) { x = y; y = (x + n / x) / 2n; }
            return x;
        }

        // tick k has sqrtPrice ~= 1.0001^(k/2) * 2^96 (see bounded-walk.test.js).
        function sqrtAtTick(tick) {
            return BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
        }

        // readL(target) => effectiveLiquidity(..., target, 8) for the pool under test,
        // with the OTHER (synthetic defended) leg held at (sd, ldDef). Returns the
        // pass-1 restore, the converged true restore, and the raw L's.
        async function passVsTrue(readL, spotL, sd, sa) {
            const lPass1 = await readL(sd); // pass-1: bounded at the OTHER pool's current price
            const ldDef = bigintSqrt(spotL * lPass1); // straddle: between near-spot and pass-1

            const [sdFinalP1] = await mp.meetBoth(sd, ldDef, 1, 1, sa, lPass1, 1, 1);
            const restorePass1 = restoreFrac(sd, sdFinalP1, sa);

            // iterate the own-meet bound to a fixed point: meet, re-bound the walk at
            // the resulting own meet price, repeat.
            let la = lPass1;
            for (let i = 0; i < 6; i++) {
                const [, saF] = await mp.meetBoth(sd, ldDef, 1, 1, sa, la, 1, 1);
                la = await readL(saF);
            }
            const lTrue = la;
            const [sdFinalTrue] = await mp.meetBoth(sd, ldDef, 1, 1, sa, lTrue, 1, 1);
            const restoreTrue = restoreFrac(sd, sdFinalTrue, sa);

            // VanHelsing's two-pass combine for the anchor (one step of the iteration
            // above): re-walk at its OWN pass-1 final (saF1) and keep the DIRECTIONAL
            // driver read, max(pass1, pass2) (_pass2; the anchor here stands in for a
            // cliffy DRIVER whose core the re-walk recovers). For a cliffy leg
            // pass-2 > pass-1, so max = pass-2 = the recovered core, still bracketed by the
            // converged fixed point: it must recover >= pass-1 without exceeding true.
            const [, saF1] = await mp.meetBoth(sd, ldDef, 1, 1, sa, lPass1, 1, 1); // anchor's pass-1 final
            const lPass2 = await readL(saF1);
            const lCombined = lPass2 > lPass1 ? lPass2 : lPass1;
            expect(lCombined).to.be.gte(lPass1);
            expect(lCombined).to.be.lte(lTrue);

            return { ldDef, lPass1, lTrue, restorePass1, restoreTrue, recovery: Number(restoreTrue) / Number(restorePass1), lCombined };
        }

        function logCase(label, r) {
            console.log(
                `  [${label}] Ld(straddle)=${r.ldDef}\n` +
                `    L_pass1=${r.lPass1}  restore=${(Number(r.restorePass1) / 1e4).toFixed(2)}%\n` +
                `    L_true =${r.lTrue}  restore=${(Number(r.restoreTrue) / 1e4).toFixed(2)}%\n` +
                `    recovery = ${r.recovery.toFixed(3)}x`,
            );
            summary.push({
                case: label,
                L_pass1: r.lPass1.toString(),
                L_true: r.lTrue.toString(),
                "restore1%": (Number(r.restorePass1) / 1e4).toFixed(2),
                "restoreT%": (Number(r.restoreTrue) / 1e4).toFixed(2),
                recovery: r.recovery.toFixed(3) + "x",
            });
        }

        it("PASS-1 vs TRUE: real V4 USDT/WBNB anchor against a straddling defended pool", async function () {
            const cfg = configV4([4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]);
            const [sa, spotL] = await v4reader.normalize(cfg);
            // A sweep of sqrt bumps (0.5%..5%, "up", the steeper measured cliff direction)
            // showed recovery rising from 1.00x (no crossing below ~0.55%) to a peak around
            // ~1.25% (~1.45x) and easing back off toward ~1.2x by 5%; this bump sits at
            // that peak, the regime where the pass-1/true gap matters most for this pool.
            const sd = sa + sa / 80n;
            const r = await passVsTrue((t) => v4d.effectiveLiquidity(cfg, t, 8), spotL, sd, sa);
            logCase("real V4 USDT/WBNB", r);
            expect(r.recovery).to.be.gte(1); // the true bound never restores less than pass-1's
        });

        it("PASS-1 vs TRUE: controlled cliffy MockV3TickPool anchor", async function () {
            const t0 = "0x1111111111111111111111111111111111111111";
            const t1 = "0x2222222222222222222222222222222222222222";
            const D = 10n ** 24n, T = 10n ** 20n; // deep core D+T, thin skirt T (same shape as Part A)
            const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D + T, 10, t0, t1]);
            await pool.setTick(-2000, T); // skirt edge, compressed tick 200
            await pool.setTick(-100, D); // core edge, compressed tick 10
            await pool.setTick(100, -D);
            await pool.setTick(2000, -T);
            const addr = await pool.getAddress();
            const sa = Q96, spotL = await pool.liquidity();
            const sd = sqrtAtTick(250); // compressed tick 25: just past the core edge, deep in the skirt
            const r = await passVsTrue((t) => v3d.effectiveLiquidity(addr, t, 8), spotL, sd, sa);
            logCase("cliffy mock", r);
            expect(r.recovery).to.be.gte(1);
        });

        it("CONTROL: uniform anchor -> pass-1 and true coincide (recovery ~1x)", async function () {
            const t0 = "0x1111111111111111111111111111111111111111";
            const t1 = "0x2222222222222222222222222222222222222222";
            const D = 10n ** 24n;
            const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D, 10, t0, t1]);
            await pool.setTick(-5000, D);
            await pool.setTick(5000, -D);
            const addr = await pool.getAddress();
            const sa = Q96, spotL = await pool.liquidity();
            const sd = sa + sa / 10n; // a generous +10% bump, still well inside the flat +-5000 range
            const r = await passVsTrue((t) => v3d.effectiveLiquidity(addr, t, 8), spotL, sd, sa);
            logCase("uniform control", r);
            // no cliff -> no gap to recover (plain-number closeTo: chai-ethers overrides
            // closeTo to expect BigInt-like args, so compare the delta directly instead)
            expect(Math.abs(r.recovery - 1)).to.be.lt(0.001);
        });

        after(function () {
            if (summary.length) {
                console.log("\n  ==== PASS-1 vs TRUE capture-recovery summary ====");
                console.table(summary);
            }
        });
    });
});
