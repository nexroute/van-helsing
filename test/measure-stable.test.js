import { network } from "hardhat";
import { expect } from "chai";
import { ethers as ethersLib } from "ethers";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { stableModel, stableOut, swapOut, v2Model, concModel, sqrtPriceOf, sqrtAtTick, stableNormalizeModel, isqrt, profit, Q96, Q192 } from "./lib/pool-model.js";
import { captureFraction, concLegL, stableNormalize, capStableL, feeND, v2DriveAmount } from "./lib/capture.js";
import { describeFork } from "./helpers/fork.js";

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";

// Real BSC pools at block 69832094-1 (the same fork calibration curve-fork.test.js
// uses): PancakeStableSwap USDT/USDC (sink-only) skewed by a whale front-run, restored
// by driving the deep Pancake V3 0.01% pool as the alt.
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const STABLE = "0x3EFebC418efB585248A0D2140cfb87aFcc2C63DD";
const V3_POOL = "0x92b7807bF19b7DDdf89b706143896d05228f3121";
const HOLDER = "0x36696169c63e42cd08ce11f5deebbcebae652050"; // whale used by curve-fork.test.js's front-run
const KIND_V3 = 2, KIND_STABLE = 7;
const BLOCK = 69832094 - 1;

const STABLE_ABI = [
    "function coins(uint256) view returns (address)",
    "function balances(uint256) view returns (uint256)",
    "function A() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function FEE_DENOMINATOR() view returns (uint256)",
    "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
    "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external",
];
const V3_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint32 d, bool e)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)",
    "function fee() view returns (uint24)",
    "function tickBitmap(int16) view returns (uint256)",
    "function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 fg0, uint256 fg1, int56 tc, uint160 spl, uint32 so, bool init)",
];

function relErr(a, b) { const hi = a > b ? a : b; return hi === 0n ? 0 : Number(((a > b ? a - b : b - a) * 1000000n) / hi) / 1000000; }

const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
function clampSqrt(s) { return s < MIN_SQRT ? MIN_SQRT : s > MAX_SQRT ? MAX_SQRT : s; }

describeFork("pool-model engine (stable)", function () {
    // Same A (1000) and fee (0.01% over 1e10) as the real calibrated PancakeStableSwap
    // pool below, so these read as the shape the fork calibration actually exercises.
    const A = 1000n;
    const FEE_DEN = 10_000_000_000n, FEE_NUM = FEE_DEN - 1_000_000n;

    it("balanced pool: a unit swap is ~1:1 minus fee (real price impact, but tiny at this size)", function () {
        const b = 1_000_000n * ONE;
        const model = stableModel(b, b, A, FEE_NUM, FEE_DEN);
        const dy = stableOut(model, ONE, true);
        const feeAdjusted = ONE - (ONE * (FEE_DEN - FEE_NUM)) / FEE_DEN; // 1e18 * keep-fraction
        expect(dy, "a real curve has SOME price impact, however small").to.be.lt(feeAdjusted);
        expect(relErr(dy, feeAdjusted), "but at 1-in-1,000,000 it should be minute").to.be.lte(1e-6);
    });

    it("imbalanced pool still prices a small swap near peg (A-aware, not the raw balance ratio)", function () {
        // Same 3:4 imbalance as the real pool below (post front-run it's actually worse).
        const b0 = 300_000n * ONE, b1 = 400_000n * ONE;
        const model = stableModel(b0, b1, A, FEE_DEN, FEE_DEN); // no fee, cleanest read
        const dy = stableOut(model, ONE, true);
        // a naive constant-product tangent from these balances would price a unit swap
        // at ~4/3 (the raw ratio); the real (A-aware) curve stays close to 1:1 instead.
        expect(b1 * 3n, "sanity: the setup really is imbalanced 3:4").to.equal(b0 * 4n);
        expect(relErr(dy, ONE), "near peg despite the imbalance").to.be.lte(0.01);
    });

    it("is a real curve: diminishing returns, and flatter than constant-product at the same reserves", function () {
        const b = 1_000_000n * ONE;
        const model = stableModel(b, b, A, FEE_DEN, FEE_DEN); // no fee, isolating curve shape
        const dx = 500_000n * ONE; // half the pool in one shot

        const dy = stableOut(model, dx, true);
        expect(dy).to.not.equal(dx); // not a hardcoded 1:1 stub
        expect(dy).to.be.lt(dx); // real price impact at this size

        const dyCP = swapOut(v2Model(b, b, FEE_DEN, FEE_DEN), dx, true);
        expect(dy, "amplified: meaningfully better execution than plain constant-product").to.be.gt(dyCP);

        // diminishing returns: a much smaller trade clears at a strictly better rate.
        // Cross-multiplied (dySmall/dxSmall > dy/dx) so the comparison stays pure BigInt.
        const dySmall = stableOut(model, ONE, true);
        expect(dySmall * dx, "smaller trades get a better marginal rate").to.be.gt(dy * ONE);
    });
});

describeFork("CurveLib price and depth, balance-scaled probes (engine port)", function () {
    // The depth stays the near-peg TANGENT fit (a directional-secant replacement was
    // measured and rejected); only the PRICE probe is balance-scaled here. Saturation
    // over-sizing is handled by the capacity cap inside CurveLib.depth, tested in its own
    // describe below.
    const FEE = [9996000000n, 10000000000n]; // 0.04% over 1e10, as the real pool
    const T = (b0, b1, A = 1000n) => stableModel(b0, b1, A, FEE[0], FEE[1]);
    const ONE = 10n ** 18n;

    it("keeps the amplified near-peg depth: > 100x CP on a mild 3:4 pool", function () {
        const m = T(3_000_000n * ONE, 4_000_000n * ONE);
        const { l } = stableNormalizeModel(m);
        expect(l > 100n * isqrt(m.b0 * m.b1)).to.equal(true); // the sanity floor holds with balance-scaled probes
    });

    it("prices small pools sanely: no phantom price at 0.1-token balances", function () {
        const m = T(10n ** 17n, 10n ** 17n); // 0.1 token each, at peg
        const { s, l } = stableNormalizeModel(m);
        const peg = 1n << 96n;
        // within 1% of peg (a fixed 1e18 quote would read a phantom ~0.316x peg)
        expect(s > (peg * 99n) / 100n && s < (peg * 101n) / 100n).to.equal(true);
        expect(l > 0n).to.equal(true);
    });

    it("no probe collision at b0 ~= 1e20: depth stays within 2000x of CP at peg", function () {
        // FIXED probes would collide here (1e18 unit quote == b0/100 reference
        // trade), collapsing the depth fit's denominator to rounding noise and
        // reading ~8e26x CP. The balance-scaled unit quote (b0/1000 = 1e17) stays
        // distinct from the b0/100 reference at every pool size, so the tangent
        // reads the honest amplification instead (measured ~1112x here, the
        // scale-invariant b0-proportional-probes regime; 2000x is far below any
        // collision-style blow-up while leaving honest-read headroom).
        const m = T(10n ** 20n, 10n ** 20n); // the exact point where fixed probes collide
        const { l } = stableNormalizeModel(m);
        expect(l < 2000n * isqrt(m.b0 * m.b1)).to.equal(true);
        expect(l > 100n * isqrt(m.b0 * m.b1)).to.equal(true);
    });

    it("refuses dust pools: POOL_DUST instead of a phantom read", function () {
        expect(() => stableNormalizeModel(T(500n, 500n))).to.throw("POOL_DUST");
    });
});

describeFork("CurveLib.depth capacity cap for a stable sink", function () {
    // The cap (inside CurveLib.depth on-chain, capStableL in capture.js) bounds the
    // tangent's linearized stable depth so its implied output over the restore's whole
    // price interval [sOwn, sOther] cannot exceed HALF the output-side balance. Sized
    // through the SHIPPED MeetingPrice via the harness: exactly the sizing path the
    // sweep (measure-sweep.test.js) and the fork calibration use.
    const FEE = [9996000000n, 10000000000n];
    const ONE = 10n ** 18n;
    let conn, h;

    before(async function () {
        this.timeout(60000);
        // fork-free on purpose (see measure-sweep.test.js's identical note): the shared
        // config's hardhat network forks by default, and this describe needs no chain.
        conn = await network.create({ network: "hardhat", override: { forking: { enabled: false } } });
        const mp = await deploy(conn, "MeetingPriceHarness");
        h = { mp, conn };
    });

    // A V2 defended at `bump` above the stable's peg (the sweep's buildV2At shape).
    function v2At(sqrtP, L) {
        const r0 = (L * Q96) / sqrtP, r1 = (L * sqrtP) / Q96;
        return v2Model(r0, r1, 9975n, 10000n);
    }

    it("ratio-extreme saturation: the cap binds and the sized drive no longer overshoots", async function () {
        this.timeout(60000);
        // The sweep's worst saturation shape: a deep dislocated defended (L = 1e24)
        // against a tiny stable sink (balances 1e21, ratio 1e-3) at a 50% sqrt
        // dislocation. Uncapped, the tangent promises ~938x the stable's balances and
        // the drive's output exceeds the pool's ENTIRE balance: a guaranteed overshoot
        // (MeetingPrice's interval clamp does not catch it, since the target is
        // genuinely in-interval).
        const defended = v2At(Q96 + Q96 / 2n, 10n ** 24n);
        const alt = stableModel(10n ** 21n, 10n ** 21n, 1000n, FEE[0], FEE[1]);

        const { s: sa, l: laRaw } = stableNormalizeModel(alt);
        const sd = sqrtPriceOf(defended);

        // the cap binds: the tangent far exceeds the payable-capacity bound here
        const laCapped = capStableL(alt, laRaw, sa, sd);
        expect(laCapped < laRaw).to.equal(true);
        expect(laCapped * 100n < laRaw).to.equal(true); // binds by over 100x, not marginally

        // non-vacuity: sized from the UNCAPPED tangent, this exact scenario is a real
        // overshoot, and the chosen drive loses money.
        const [nd, dd] = feeND(defended), [na, da] = feeND(alt);
        const [sdFRaw] = await h.mp.meetBoth(sd, 10n ** 24n, nd, dd, sa, laRaw, na, da);
        const dir = sd > BigInt(sdFRaw);
        expect(dir).to.equal(true); // defended dislocated above -> restore drives its price down
        // reproduce vanHelsingDriveSize minus the cap, then score the same way
        const chosenUncapped = v2DriveAmount(defended, BigInt(sdFRaw), dir);
        const rUncapped = profit(defended, alt, chosenUncapped, dir);
        expect(rUncapped < 0n, `uncapped sizing must overshoot here (got ${rUncapped})`).to.equal(true);

        // with the cap wired into the shipped sizing path: no overshoot, real profit.
        const r = await captureFraction(h, defended, alt, dir);
        expect(r.overshoot).to.equal(false);
        expect(r.chosenProfit > 0n, `capped sizing must realize a profit (got ${r.chosenProfit})`).to.equal(true);
        expect(r.optimalProfit > 0n).to.equal(true); // a genuine arb existed: the uncapped loss was over-sizing
    });

    it("near-peg: the cap provably does not bind (cap >> tangent), sizing unchanged", function () {
        // 0.01% sqrt dislocation at matched depth, the near-peg regime the tangent
        // reads honestly. Zero-fee control first for the clean geometric statement
        // (the stable's own quote price sits exactly at peg, so the interval is the
        // bump alone): cap ~= B/(2*1e-4) = 5000x B vs tangent ~= 1000x B.
        const L = 10n ** 24n;
        const defended = v2At(Q96 + Q96 / 10000n, L);
        const alt0 = stableModel(L, L, 1000n, FEE[1], FEE[1]); // zero-fee control
        const { s: sa0, l: laRaw0 } = stableNormalizeModel(alt0);
        const sd = sqrtPriceOf(defended);
        expect(capStableL(alt0, laRaw0, sa0, sd)).to.equal(laRaw0); // untouched
        const cap0 = ((alt0.b0 / 2n) * ((sd * sa0) / Q96)) / (sd - sa0);
        expect(cap0 > laRaw0 * 2n).to.equal(true); // several times the tangent, not marginal

        // and at the real 0.04% fee: the fee-implied offset of the stable's own quote
        // price widens the interval (~0.02% on top of the bump), thinning the margin
        // to ~1.66x, still non-binding.
        const alt = stableModel(L, L, 1000n, FEE[0], FEE[1]);
        const { s: sa, l: laRaw } = stableNormalizeModel(alt);
        expect(capStableL(alt, laRaw, sa, sd)).to.equal(laRaw); // untouched
        const cap = ((alt.b0 / 2n) * ((sd * sa) / Q96)) / (sd - sa);
        expect(cap > laRaw).to.equal(true);
    });

    it("no-op guards: non-stable legs and equal prices pass through untouched", function () {
        const L = 10n ** 24n;
        const v2 = v2At(Q96, L);
        expect(capStableL(v2, L, Q96, Q96 * 2n)).to.equal(L); // not a stable leg
        const st = stableModel(L, L, 1000n, FEE[0], FEE[1]);
        expect(capStableL(st, L, Q96, Q96)).to.equal(L); // sOwn == sOther: meet no-ops anyway
    });

    // The raw cap itself can floor to 0 (integer division, not a corner the formula
    // special-cases), and a 0 cap is not "no capacity": MeetingPrice.meet's `la == 0`
    // branch reads it as an INFINITELY deep sink (the tick-in-a-gap passthrough), driving
    // a full restore into a pool that can pay almost nothing, so the cap would invert its
    // own purpose. POOL_DUST does not rule this out; it only bounds b0 (indirectly, via
    // the unit quote) and the quote itself, never b1 or either price's magnitude.
    // MockCurvePool's get_dy is a constant 1:1 (peg) independent of its balances (the
    // same decoupling curve.test.js's own "prices off get_dy ... not the balances ratio"
    // test relies on), which is what lets this test isolate the cap's floor behavior at
    // the exact point it inverts (a real Curve invariant pool resists reaching b1 = 1
    // while its own get_dy still quotes non-dust, since the same tiny balance that
    // starves the cap also starves the quote; a registered pool with a decoupled/mocked
    // or otherwise pathological quote path does not have that protection, which is the
    // "grotesque-but-registered" case the floor guards).
    it("zero cap: a raw cap that would floor to 0 floors to 1 instead, and never full-restores", async function () {
        this.timeout(60000);
        const b0 = 10n ** 24n, b1 = 1n; // 1-wei output-side balance: b1/2n floors to 0n
        const pool = await deploy(conn, "MockCurvePool", null, [USDT, USDC, b0, b1]);
        const curveLib = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
        const h2 = { mp: h.mp, curveLib, conn };
        const alt = stableModel(b0, b1, 1000n, FEE[0], FEE[1], {
            pool: await pool.getAddress(), t0: USDT, t1: USDC, curveKind: KIND_STABLE,
        });

        // Defended well below the stable's pegged quote (a wide sd/sa interval), so
        // sOther (defended) <= sOwn (alt): the falling branch, which reads b1.
        const defended = v2At(Q96 / 2n, 10n ** 24n);
        const { s: sa, l: laRaw } = await stableNormalize(h2, alt);
        const sd = sqrtPriceOf(defended);
        expect(sd <= sa, "falling branch requires sOther (defended) <= sOwn (alt)").to.equal(true);

        // Non-vacuity: the RAW (unfloored) formula genuinely floors to 0 here. b1/2n is 0n
        // identically, so the fullMulDiv product is 0 regardless of the interval's width:
        // the "tiny output-side balance" mechanism, not a coincidence of how wide the
        // interval happens to be (widening it further would not change this).
        const rawCap = ((alt.b1 / 2n) * Q96) / (sa - sd);
        expect(rawCap, "non-vacuity: the raw cap must actually floor to 0 in this scenario").to.equal(0n);

        // (a) capStableL never returns 0: it floors to exactly 1 wei instead.
        const laCapped = capStableL(alt, laRaw, sa, sd);
        expect(laCapped >= 1n, `capped L must be >= 1n, got ${laCapped}`).to.equal(true);
        expect(laCapped, "capStableL floors the degenerate cap to exactly 1 wei").to.equal(1n);

        // (b) captureFraction on this leg does NOT full-restore: a 1-wei sink can absorb
        // essentially nothing, so the sized drive rounds to ~0 and the realized profit is
        // <= 0 (a clean no-op), not the doomed full restore a raw la == 0 passthrough
        // would have driven MeetingPrice.meet toward.
        const [nd, dd] = feeND(defended), [na, da] = feeND(alt);
        const [sdFRaw] = await h.mp.meetBoth(sd, 10n ** 24n, nd, dd, sa, laRaw, na, da);
        const dir = sd > BigInt(sdFRaw);
        const r = await captureFraction(h2, defended, alt, dir);
        expect(r.chosen, `drive size must round to ~0, not a full restore (got ${r.chosen})`).to.be.lte(1n);
        expect(r.chosenProfit <= 0n, `must not full-restore (got chosenProfit=${r.chosenProfit})`).to.equal(true);
    });
});

// Helpers shared by the fork calibrations.

// Initialized ticks in [tickLo, tickHi] from a Uniswap-V3-shaped pool (the same reader as
// readV3Ticks in ./lib/fork-ticks.js; see that file for the bitmap-scan notes).
async function readV3Ticks(provider, poolAddr, spacing, tickLo, tickHi) {
    const pool = new ethersLib.Contract(poolAddr, V3_ABI, provider);
    const cLo = Math.floor(tickLo / spacing), cHi = Math.floor(tickHi / spacing);
    const wLo = cLo >> 8, wHi = cHi >> 8;
    const ticks = [];
    for (let w = wLo; w <= wHi; w++) {
        const word = BigInt(await pool.tickBitmap(w));
        if (word === 0n) continue;
        for (let b = 0n; b < 256n; b++) {
            if (((word >> b) & 1n) === 0n) continue;
            const comp = (w << 8) + Number(b);
            if (comp < cLo || comp > cHi) continue;
            const tick = comp * spacing;
            const [, liquidityNet] = await pool.ticks(tick);
            ticks.push({ tick, liqNet: liquidityNet });
        }
    }
    return ticks;
}

// Floor tick of a sqrt price, by bisection over the ported TickMath.
function tickAtSqrt(s) {
    let lo = -887272, hi = 887272;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sqrtAtTick(mid) <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
}

describeFork("VanHelsing stableswap sink: FORK CALIBRATION (gate)", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        this.timeout(600000);
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    // CALIBRATION (a): the engine's stableOut against the REAL pool's own get_dy view,
    // no VanHelsing/ward involved: validates the curve math and the A convention
    // (Ann = A() * 2, see pool-model.js) directly against the live contract.
    it("CALIBRATION (a): stableOut matches the real pool's get_dy exactly", async function () {
        this.timeout(120000);
        const pool = new ethersLib.Contract(STABLE, STABLE_ABI, ethers.provider);
        const [coin0, b0, b1, A, fee, feeDen] = await Promise.all([
            pool.coins(0), pool.balances(0), pool.balances(1), pool.A(), pool.fee(), pool.FEE_DENOMINATOR(),
        ]);
        expect(coin0.toLowerCase(), "pin the pool's own coin0 so zeroForOne below means coin0->coin1").to.equal(USDT.toLowerCase());
        const feeNum = feeDen - fee;
        const model = stableModel(b0, b1, A, feeNum, feeDen);

        for (const dx of [ONE, 100n * ONE, 10_000n * ONE, 150_000n * ONE]) {
            for (const zeroForOne of [true, false]) {
                const [i, j] = zeroForOne ? [0n, 1n] : [1n, 0n];
                const real = await pool.get_dy(i, j, dx);
                const engine = stableOut(model, dx, zeroForOne);
                expect(engine, `dx=${dx} zeroForOne=${zeroForOne}`).to.equal(real);
            }
        }
    });

    // CALIBRATION (b): end-to-end, reusing curve-fork.test.js's exact scenario (front-run
    // the stableswap, then ward it as the defended). The stableswap can't flash
    // (CurveLib.sol), so VanHelsing actually drives the V3 alt and sinks into the
    // stableswap; capture.js's resolveDriver makes the same flip.
    it("CALIBRATION (b): engine profit(chosen) matches a real ward's realized gain within 1%", async function () {
        this.timeout(600000);

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], {
            libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null },
        });
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const curveLib = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
        const h = { mp, v3depth, curveLib, conn };

        const stableRO = new ethersLib.Contract(STABLE, STABLE_ABI, ethers.provider);
        const v3RO = new ethersLib.Contract(V3_POOL, V3_ABI, ethers.provider);
        const [stableFeeRaw, feeDen, v3FeeRaw] = await Promise.all([stableRO.fee(), stableRO.FEE_DENOMINATOR(), v3RO.fee()]);

        await registry.setPools(USDT, USDC, [
            [idAddr(V3_POOL), KIND_V3, v3FeeRaw, 0],
            [idAddr(STABLE), KIND_STABLE, stableFeeRaw, 0],
        ]);

        // front-run: dump USDT into the stableswap (verbatim from curve-fork.test.js).
        await networkHelpers.impersonateAccount(HOLDER);
        await networkHelpers.setBalance(HOLDER, 100n * ONE);
        const whale = await ethers.getSigner(HOLDER);
        const fr = 200_000n * ONE;
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const usdc = await ethers.getContractAt("IERC20", USDC);
        const stableRW = new ethers.Contract(STABLE, STABLE_ABI, whale);
        await usdt.connect(whale).approve(STABLE, fr);
        await stableRW.exchange(0, 1, fr, 0);
        await networkHelpers.stopImpersonatingAccount(HOLDER);

        // Read the REAL post-front-run state the ward will act on.
        const [b0, b1, A] = await Promise.all([stableRO.balances(0), stableRO.balances(1), stableRO.A()]);
        const stableFeeNum = feeDen - stableFeeRaw;
        const defModel = stableModel(b0, b1, A, stableFeeNum, feeDen, { pool: STABLE, t0: USDT, t1: USDC, curveKind: KIND_STABLE });

        // Bonus rigor: the exact model about to feed the engine reproduces the real
        // pool's get_dy at this exact (imbalanced, post-front-run) state too, not just
        // calibration (a)'s separate snapshot.
        const dyReal = await stableRO.get_dy(0, 1, 1000n * ONE);
        expect(stableOut(defModel, 1000n * ONE, true), "defModel must match get_dy at the state the ward acts on").to.equal(dyReal);

        // Port-vs-harness: the JS port evaluated on this exact fork state must reproduce the
        // real CurveLib price and depth exactly (read through CurveLibHarness.normalize):
        // both read the identical Curve math off the identical balances, so nothing but a
        // genuine port bug could differ.
        const portNorm = stableNormalizeModel(defModel);
        const harnessNorm = await stableNormalize(h, defModel);
        console.log(`  [port-vs-harness] port s=${portNorm.s} l=${portNorm.l}; harness s=${harnessNorm.s} l=${harnessNorm.l}`);
        expect(portNorm.s, "port sqrtPrice must match CurveLib.price on the fork pool").to.equal(harnessNorm.s);
        expect(portNorm.l, "port liquidity must match CurveLib.depth on the fork pool").to.equal(harnessNorm.l);

        const [s0, spotL, spacingRaw] = await Promise.all([v3RO.slot0(), v3RO.liquidity(), v3RO.tickSpacing()]);
        const spacing = Number(spacingRaw);
        const sqrtP = BigInt(s0.sqrtPriceX96);
        const spotTick = Number(s0.tick);
        const feeNumV3 = 1_000_000n - v3FeeRaw, feeDenV3 = 1_000_000n;

        // Two-phase tick read (as measure-conc.test.js does): a coarse band first to find
        // the meet target via the shipped MeetingPrice + CurveLib price and depth, then a
        // wider precise band spanning [spot, target].
        const band0 = await readV3Ticks(ethers.provider, V3_POOL, spacing, spotTick - 50 * spacing, spotTick + 50 * spacing);
        const probe0 = concModel(sqrtP, spotTick, spacing, band0, feeNumV3, feeDenV3, spotL);
        const { target, dir } = await meetAndDirStable(h, defModel, probe0);
        const targetTick = tickAtSqrt(clampSqrt(target));
        const lo = Math.min(spotTick, targetTick) - 50 * spacing, hi = Math.max(spotTick, targetTick) + 50 * spacing;
        const ticks = await readV3Ticks(ethers.provider, V3_POOL, spacing, lo, hi);
        const altModel = concModel(sqrtP, spotTick, spacing, ticks, feeNumV3, feeDenV3, spotL);

        const { capture, chosenProfit, optimalProfit, chosen, overshoot } = await captureFraction(h, defModel, altModel, dir);
        expect(chosenProfit, "engine profit not positive").to.be.gt(0n);

        // realized: ward the stableswap as the defended id (as curve-fork.test.js
        // does) and read the beneficiary's balance change in EACH token. The stableswap
        // sink is always exact-in (_isStable forces exactOut=false), so base = drive
        // direction's input token: t0 (USDT) when dir (zeroForOne) is true, else t1 (USDC).
        const u0 = await usdt.balanceOf(BENEFICIARY), c0 = await usdc.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](idAddr(STABLE), BENEFICIARY, { gasLimit: 6_000_000 });
        const usdtDelta = (await usdt.balanceOf(BENEFICIARY)) - u0;
        const usdcDelta = (await usdc.balanceOf(BENEFICIARY)) - c0;
        const [realized, offDelta] = dir ? [usdtDelta, usdcDelta] : [usdcDelta, usdtDelta];
        expect(offDelta, `non-payout token delta should be exactly 0, got ${offDelta}`).to.equal(0n);
        expect(realized, "nothing realized").to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdc.balanceOf(await vh.getAddress())).to.equal(0n);

        const err = relErr(chosenProfit, realized);
        console.log(`  [stable sink] engine=${chosenProfit} realized=${realized} chosen=${chosen} capture=${(capture * 100).toFixed(2)}% optimal=${optimalProfit} overshoot=${overshoot} relErr=${(err * 100).toFixed(6)}%`);
        expect(err, `engine ${chosenProfit} vs realized ${realized} = ${(err * 100).toFixed(4)}%`).to.be.lte(0.01);
        expect(capture).to.be.within(0, 1);
        expect(capture).to.be.gte(0.82); // the capacity cap must not regress the near-peg under-sizing
    });
});

// meet target + drive direction for (stable defended, conc alt): the stableswap can
// never drive (CurveLib.sol has no flash mode), so the ALT is the actual driver and
// `dir`/`target` are ITS OWN (current, final), as VanHelsing._pickDriver flips to the
// alt when the defended can't flash. sd/ld come through the shipped CurveLib price and
// depth (stableNormalize), never a pure-JS approximation.
async function meetAndDirStable(h, defModel, altModel) {
    const { s: sd, l: ld } = await stableNormalize(h, defModel);
    const sa = clampSqrt(sqrtPriceOf(altModel));
    const la = await concLegL(h, altModel, sd);
    const [, saF] = await h.mp.meetBoth(clampSqrt(sd), ld, defModel.feeNum, defModel.feeDen, sa, la, altModel.feeNum, altModel.feeDen);
    const target = clampSqrt(saF);
    return { target, dir: sa > target };
}
