import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { concModel, sqrtAtTick, tickAtSqrt } from "./lib/pool-model.js";
import { concLegL } from "./lib/capture.js";

// Edge and invariant cases: VanHelsing stays SAFE (never reverts the caller, never
// loses funds, never strands residue, correctly no-ops) at the extremes of price,
// depth, and degeneracy. Mock-based, no fork: runs in seconds.
//
// Every case asserts the same three outward invariants (see wardAndCheck below):
//   1. ward() never reverts the caller.
//   2. the beneficiary's balance of each pair token never DECREASES (no fund loss).
//   3. VanHelsing's own balance of each pair token is zero after (no stranded residue).
// A capture case additionally asserts the beneficiary GAINED (> 0); a no-op case
// asserts the beneficiary is UNCHANGED.
//
// EXECUTABLE vs VIEW-ONLY, the split this file respects throughout:
// MockV2Pool enforces its k-invariant as (b0*FEE_DEN)*(b1*FEE_DEN), a uint256 product.
// With reserves near uint128 max on BOTH sides that product overflows uint256: a
// false failure in the MOCK, not in VanHelsing. So a TRUE extreme (a literal
// MIN_SQRT/MAX_SQRT price, near-uint128-max liquidity) cannot be driven through an
// executable V2 ward without faking the result; those cases instead assert, view-only,
// that the SHIPPED sizer (MeetingPriceHarness.meetBoth) and walk
// (V3DepthHarness.effectiveLiquidity against a MockV3TickPool) never revert and stay
// in range at the true extreme, the bounded walk's "depth read never reverts"
// guarantee. Moderate-but-extreme ratios, near-zero depth, and every degenerate case
// are real, executable MockV2Pool wards asserting the full invariant set above.

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
// TickMath sqrt-ratio bounds, matching VanHelsing's own internal MIN_SQRT/MAX_SQRT
// (MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO - 1: some paths reject the raw ratio bounds
// themselves, so these are the honest "at the bound" values; same constants as
// measure-conc.test.js / bounded-walk.test.js).
const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const UINT128_MAX = (1n << 128n) - 1n;

const LIBS = {
    libraries: {
        CurveLib: null, UniV4Lib: null, InfinityLib: null,
        V3Depth: null, V4Depth: null, RouteLib: null,
    },
};

describe("VanHelsing edge / invariant cases", function () {
    let conn, ethers, me, mp, v3depth, h;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
        mp = await deploy(conn, "MeetingPriceHarness");
        v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        h = { mp, v3depth, conn };
    });

    async function mkToken(sym) { return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]); }
    async function mkPool(x, y, rx, ry, feeNum = 9975n) {
        const ax = (await x.getAddress()).toLowerCase(), ay = (await y.getAddress()).toLowerCase();
        const [t0, t1, r0, r1] = ax < ay ? [x, y, rx, ry] : [y, x, ry, rx];
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), feeNum, 10000n]);
        await t0.mint(me.address, r0); await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0); await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return pool;
    }

    // Shared wiring behind mkDislocation/mkDislocationSorted: a fresh registry +
    // VanHelsing, a defended pool and an alt pool over the given (already
    // positioned) token pair, registered and ready to ward. `t0`/`t1` come back as
    // `A`/`X`, the names both callers destructure.
    async function mkDislocationWith(t0, t1, defR0, defR1, altR0, altR1, feeNum) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], LIBS);
        const defended = await mkPool(t0, t1, defR0, defR1, feeNum);
        const alt = await mkPool(t0, t1, altR0, altR1, feeNum);
        const defId = idAddr(await defended.getAddress());
        const altId = idAddr(await alt.getAddress());
        await registry.setPools(await t0.getAddress(), await t1.getAddress(), [[defId, 0, 25, 0], [altId, 0, 25, 0]]);
        return { registry, vh, A: t0, X: t1, defended, alt, defId, altId };
    }

    // A full, self-contained defended/alt V2 pair, registered and ready to ward. The
    // one constructor every executable case in this file builds from: an extreme
    // ratio, dust reserves, equal prices, a hair off, or literally empty are all just
    // a choice of (defR0, defR1, altR0, altR1).
    async function mkDislocation(defR0, defR1, altR0, altR1, feeNum = 9975n) {
        const A = await mkToken("A"), X = await mkToken("X");
        return mkDislocationWith(A, X, defR0, defR1, altR0, altR1, feeNum);
    }

    // like mkDislocation, but assigns reserves by SORTED token position, so the
    // caller controls which side lands as r1. That reaches _normalize's V2
    // sqrt-first branch deterministically: only r1/r0 (not the named-token ratio)
    // decides whether the exact form would overflow fullMulDiv.
    async function mkDislocationSorted(defR0, defR1, altR0, altR1) {
        const a = await mkToken("T0"), b = await mkToken("T1");
        const [lo, hi] = (await a.getAddress()).toLowerCase() < (await b.getAddress()).toLowerCase() ? [a, b] : [b, a];
        return mkDislocationWith(lo, hi, defR0, defR1, altR0, altR1, 9975n);
    }

    async function beneOf(tokens) {
        const out = [];
        for (const t of tokens) out.push(await t.balanceOf(BENEFICIARY));
        return out;
    }

    // The whole point of this file: run ward() and assert the three outward safety
    // invariants that must hold no matter what: never reverts the caller, never
    // takes the beneficiary's balance DOWN, never strands a pair token inside
    // VanHelsing. Returns the beneficiary's per-token deltas so the caller can assert
    // the correct OUTCOME on top (a no-op: every delta zero; a capture: the deltas
    // sum to something positive).
    async function wardAndCheck(vh, defId, tokens, gasLimit = 6_000_000) {
        const pre = await beneOf(tokens);
        await expect(vh["ward(bytes32,address)"](defId, BENEFICIARY, { gasLimit })).to.not.be.revert(ethers);
        const post = await beneOf(tokens);
        for (let i = 0; i < tokens.length; i++) {
            expect(post[i], `token[${i}] beneficiary balance decreased: fund loss`).to.be.gte(pre[i]);
        }
        for (const t of tokens) {
            expect(await t.balanceOf(await vh.getAddress()), "residue left stranded in VanHelsing").to.equal(0n);
        }
        return tokens.map((_, i) => post[i] - pre[i]);
    }

    describe("Step 1: extreme prices", function () {
        // Executable: both legs at a ~1e15-4e15 price ratio (far beyond any real
        // token pair) while reserves (1e6 to 4e21) stay far below uint128 max, so
        // the mock's k-check (see file header) cannot overflow. This is the honest
        // executable analog of "near a bound": the RATIO is extreme even though the
        // literal sqrtPriceX96 number is not yet at MIN_SQRT/MAX_SQRT (that touch is
        // the view-only case below, which has no such overflow risk to respect).
        //
        // The ratio is kept below 2^64 here, unlike the past-ceiling case below, which
        // deliberately goes past it. Both sides of that ceiling normalize safely, so
        // this is a smaller point on the same curve, kept as its own case for coverage
        // of the exact fullMulDiv form.
        it("V2 executable: extreme skewed reserve ratio on both legs stays safe", async function () {
            const { vh, A, X, defId } = await mkDislocation(10n ** 6n, 4n * 10n ** 21n, 10n ** 6n, 10n ** 21n);
            const [dA, dX] = await wardAndCheck(vh, defId, [A, X]);
            console.log(`  [extreme price, V2 executable] deltaA=${dA} deltaX=${dX}`);
            // a genuine 4x dislocation between two already-extreme prices: captures.
            expect(dA + dX, "expected a bounded capture at the extreme ratio").to.be.gt(0n);
        });

        // A ~4e24 price ratio with the big side as r1 puts r1/r0 past uint64.max, where
        // _normalize's exact V2 form fullMulDiv(r1, 1 << 192, r0) would overflow
        // (FullMulDivFailed, a swallowed no-op); _normalize takes the roots first there,
        // so both orientations normalize and BOTH capture the genuine 4x dislocation.
        // Sorted-position construction pins each orientation exactly.
        it("V2 executable: ratio past the fullMulDiv ceiling (r1/r0 > uint64.max) captures in both orientations", async function () {
            // big side as r1: r1/r0 = 4e24 > uint64.max, the sqrt-first branch
            const big = await mkDislocationSorted(10n ** 6n, 4n * 10n ** 30n, 10n ** 6n, 10n ** 30n);
            const [b0, b1] = await wardAndCheck(big.vh, big.defId, [big.A, big.X]);
            console.log(`  [past-ceiling, r1-heavy] delta0=${b0} delta1=${b1}`);
            expect(b0 + b1, "r1-heavy orientation should capture").to.be.gt(0n);

            // big side as r0: the exact form fits, the control orientation
            const inv = await mkDislocationSorted(4n * 10n ** 30n, 10n ** 6n, 10n ** 30n, 10n ** 6n);
            const [i0, i1] = await wardAndCheck(inv.vh, inv.defId, [inv.A, inv.X]);
            console.log(`  [past-ceiling, r0-heavy] delta0=${i0} delta1=${i1}`);
            expect(i0 + i1, "r0-heavy orientation should capture").to.be.gt(0n);
        });

        // View-only: both legs literally AT the sqrtPrice bound (MIN_SQRT/MAX_SQRT),
        // opposite ends of the whole tick range, the widest possible dislocation.
        // MockV3TickPool takes sqrtPriceX96 as a raw constructor argument (never
        // derived by multiplying reserves), so there is no overflow risk in reaching
        // the literal bound here, unlike the executable V2 mock above.
        it("concentrated view-only: sizer + walk never revert with both legs AT the sqrtPrice bound", async function () {
            const spacing = 60, feeNum = 997000n, feeDen = 1000000n, spotL = 10n ** 24n;
            const low = concModel(MIN_SQRT, tickAtSqrt(MIN_SQRT), spacing, [], feeNum, feeDen, spotL);
            const high = concModel(MAX_SQRT, tickAtSqrt(MAX_SQRT), spacing, [], feeNum, feeDen, spotL);

            // the shipped walk (V3Depth.effectiveLiquidity via concLegL), each leg
            // toward the OTHER leg's literal-bound price, the widest walk target.
            const lLow = await concLegL(h, low, MAX_SQRT);
            const lHigh = await concLegL(h, high, MIN_SQRT);
            expect(lLow).to.be.gte(0n); expect(lLow).to.be.lte(UINT128_MAX);
            expect(lHigh).to.be.gte(0n); expect(lHigh).to.be.lte(UINT128_MAX);

            // the shipped sizer (MeetingPrice.meetBoth), fed both extreme prices and
            // their walked liquidity.
            const [sdF, saF] = await mp.meetBoth(MIN_SQRT, lLow, feeNum, feeDen, MAX_SQRT, lHigh, feeNum, feeDen);
            expect(sdF).to.be.gte(MIN_SQRT); expect(sdF).to.be.lte(MAX_SQRT);
            expect(saF).to.be.gte(MIN_SQRT); expect(saF).to.be.lte(MAX_SQRT);
        });
    });

    describe("Step 2: extreme depth", function () {
        // Executable: L = sqrt(r0*r1) here is a few thousand wei, as thin as a V2
        // full-range position can be. V2 has no ticks, so "one-tick-thin" has no
        // literal V2 analog; dust reserves are the honest equivalent (depth genuinely
        // almost nothing). The concentrated view-only case below covers the other
        // extreme, liquidity at the uint128 ceiling.
        it("V2 executable: near-zero liquidity (dust reserves) stays safe", async function () {
            const { vh, A, X, defId } = await mkDislocation(1000n, 4000n, 1000n, 1000n);
            const [dA, dX] = await wardAndCheck(vh, defId, [A, X]);
            console.log(`  [near-zero L, V2 executable] deltaA=${dA} deltaX=${dX}`);
            // dust-scale reserves still stay well clear of any precision boundary (see
            // Step 1's fullMulDiv ceiling note), so this is a deterministic capture: a
            // real, if tiny, dust-wei profit, not just a lucky no-op.
            expect(dA + dX, "expected a bounded (if tiny) capture at near-zero depth").to.be.gt(0n);
        });

        // View-only: spot liquidity pinned to UINT128_MAX (the type's own ceiling),
        // walked toward the opposite sqrtPrice bound: the biggest L the walk's wSum
        // accumulator (liq * width) can ever be asked to carry. Executing this through
        // MockV2Pool would need both reserves near uint128 max simultaneously, which
        // overflows the mock's k-check (see file header); the view-only walk has no
        // such multiplication, so it can hold the type max directly with no overflow
        // risk.
        it("concentrated view-only: sizer + walk never revert or overflow at near-uint128-max liquidity", async function () {
            const spacing = 60, feeNum = 999500n, feeDen = 1000000n;
            const sqrtP = sqrtAtTick(0); // Q96, an ordinary mid-range price
            const full = concModel(sqrtP, 0, spacing, [], feeNum, feeDen, UINT128_MAX);
            const other = concModel(MAX_SQRT, tickAtSqrt(MAX_SQRT), spacing, [], feeNum, feeDen, 10n ** 24n);

            const l = await concLegL(h, full, MAX_SQRT); // walk toward the far bound at max L
            expect(l).to.be.gte(0n); expect(l).to.be.lte(UINT128_MAX);
            const lOther = await concLegL(h, other, sqrtP);

            const [sdF, saF] = await mp.meetBoth(sqrtP, l, feeNum, feeDen, MAX_SQRT, lOther, feeNum, feeDen);
            expect(sdF).to.be.gte(MIN_SQRT); expect(sdF).to.be.lte(MAX_SQRT);
            expect(saF).to.be.gte(MIN_SQRT); expect(saF).to.be.lte(MAX_SQRT);
        });
    });

    describe("Step 3: degenerate", function () {
        it("empty pool (zero reserves) is a safe no-op", async function () {
            // initReserves(0,0) is fine (transferFrom 0 succeeds); _normalize's V2
            // branch then hits require(r0>0 && r1>0, "POOL_EMPTY") inside execute(),
            // swallowed by ward(): a safe no-op, not a caller revert.
            const { vh, A, X, defId } = await mkDislocation(0n, 0n, 1000n * ONE, 1000n * ONE);
            const [dA, dX] = await wardAndCheck(vh, defId, [A, X]);
            expect(dA).to.equal(0n); expect(dX).to.equal(0n);
        });

        it("equal prices (no dislocation) is a safe no-op (NO_ARB)", async function () {
            const { vh, A, X, defId } = await mkDislocation(1000n * ONE, 1000n * ONE, 1000n * ONE, 1000n * ONE);
            const [dA, dX] = await wardAndCheck(vh, defId, [A, X]);
            expect(dA).to.equal(0n); expect(dX).to.equal(0n);
        });

        it("dust dislocation (a hair off fair) is a safe no-op (below the fee floor)", async function () {
            // 0.1% skew vs a combined ~0.5% round-trip fee (0.25% each leg): the whole
            // dislocation is eaten by fees, so there is nothing to capture.
            const { vh, A, X, defId } = await mkDislocation(1000n * ONE, 1001n * ONE, 1000n * ONE, 1000n * ONE);
            const [dA, dX] = await wardAndCheck(vh, defId, [A, X]);
            expect(dA).to.equal(0n); expect(dX).to.equal(0n);
        });

        // The exact floor boundary: measure a baseline's REAL realized profit with no
        // floor set, then replay the identical dislocation on a fresh pair with the
        // floor pinned to exactly that profit. require(profit > floor) is strict, so
        // profit == floor must reject the payout, and profit == floor-1 must still
        // clear it. Both replays are deterministic BigInt AMM math over fresh, byte-
        // identical pools, so this hits the boundary exactly rather than approximating
        // it (see route-v2.test.js's identical baseline-then-pin technique).
        it("profit exactly at the floor boundary pays out nothing; one wei under it still captures", async function () {
            const base = await mkDislocation(1000n * ONE, 4000n * ONE, 1000n * ONE, 1000n * ONE);
            const [dA, dX] = await wardAndCheck(base.vh, base.defId, [base.A, base.X]);
            const profit = dA > 0n ? dA : dX;
            const baseIsA = dA > 0n;
            expect(profit, "sanity: baseline dislocation must be genuinely profitable").to.be.gt(0n);

            const exact = await mkDislocation(1000n * ONE, 4000n * ONE, 1000n * ONE, 1000n * ONE);
            await exact.registry.setToken(await (baseIsA ? exact.A : exact.X).getAddress(), 0, profit);
            const [eA, eX] = await wardAndCheck(exact.vh, exact.defId, [exact.A, exact.X]);
            expect(eA).to.equal(0n); expect(eX).to.equal(0n); // BELOW_FLOOR (strict >): no payout

            const under = await mkDislocation(1000n * ONE, 4000n * ONE, 1000n * ONE, 1000n * ONE);
            await under.registry.setToken(await (baseIsA ? under.A : under.X).getAddress(), 0, profit - 1n);
            const [uA, uX] = await wardAndCheck(under.vh, under.defId, [under.A, under.X]);
            expect(uA + uX).to.equal(profit); // one wei under the floor: captures identically
        });
    });
});
