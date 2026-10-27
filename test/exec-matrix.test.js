import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import {
    idAddr, idV4, configV4, registerV4, idRoute, configRoute, ROUTE,
} from "./helpers/ids.js";
import { v2Model, concModel, sqrtPriceOf, stableModel, tickAtSqrt } from "./lib/pool-model.js";
import {
    captureFraction, legNormalize, concLegL, feeND, resolveDriver, stableNormalize,
    routeNormalize, routeLegL, captureFractionRoute,
} from "./lib/capture.js";
import { readV3Ticks, readV4Ticks, readV4Slot0Liq } from "./lib/fork-ticks.js";
import { describeFork } from "./helpers/fork.js";

// FORK EXECUTION MATRIX: confirms VanHelsing's execution plumbing faithfully realizes its
// sizing across the real protocol-combination grid, on forked BSC pools. The analytic
// capture engine (test/lib/capture.js) models the sizing off-chain and the measure-*.test.js
// files calibrate it; this file is the on-chain correctness complement: real wards, real
// pools, real invariants.
//
// The matrix factors into independent (pair, block) fork contexts: `registry.setPools`
// registers pools that share ONE pair, and a driver+sink must share a pair on the same
// fork block (see PoolRegistry.sol). It is therefore NOT a free driver x sink cross
// product: most cells have no real shared-pair pool and are SKIPPED + LOGGED below (see
// the MATRIX enumeration), not silently omitted.

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const NATIVE = "0x0000000000000000000000000000000000000000";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const PARAMS_TS1 = "0x0000000000000000000000000000000000000000000000000000000000010000";
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };
const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

function clampSqrt(s) { return s < MIN_SQRT ? MIN_SQRT : s > MAX_SQRT ? MAX_SQRT : s; }
function relErr(a, b) { const hi = a > b ? a : b; return hi === 0n ? 0 : Number(((a > b ? a - b : b - a) * 1000000n) / hi) / 1000000; }

// Group A/C pools: USDT/WBNB pair, block 103808000 (the exact same real pools as
// univ4-fork.test.js, infinity-fork.test.js and route-fork.test.js, verbatim).
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // Pancake V2 USDT/WBNB, kind 0, fee 25
const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849"; // Pancake V3 0.01%, kind 2, fee 100
const V4_DEEP = [4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]; // Uniswap V4 0.05%, kind 4, aligned
const V4_NATIVE = [4, NATIVE, USDT, 500, 10, NO_HOOKS, ZH]; // Uniswap V4, kind 4, FLIPPED (native currency0)
const INFI_NATIVE = [6, NATIVE, USDT, 67, 1, NO_HOOKS, PARAMS_TS1]; // Pancake Infinity CL, kind 6, native
const BLOCK_A = 103808000;
const CFG_DEEP = configV4(V4_DEEP);
const CFG_INFI = configV4(INFI_NATIVE);
const ID_V2 = idAddr(V2_PANCAKE);
const ID_V3 = idAddr(V3_DEEP);
const V3_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint32 d, bool e)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)",
    "function fee() view returns (uint24)",
];

// Group C (routes) pools: same pair/block as Group A (see route-fork.test.js).
const X = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"; // CAKE
const P1_V2 = "0x0eD7e52944161450477ee417DE9Cd3a859b14fD0"; // CAKE/WBNB Pancake V2 (defended driver)
const HOP_V3 = "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1"; // CAKE/USDT Pancake V3 0.25%
const V3_FEE_HOP = 2500;
const V4_HOP = V4_DEEP; // the same USDT/WBNB V4 pool as Group A

// Group B pools: USDT/USDC pair, block 69832094-1 (see curve-fork.test.js /
// measure-stable.test.js; a DIFFERENT pair and a DIFFERENT block from Group A/C).
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const STABLE = "0x3EFebC418efB585248A0D2140cfb87aFcc2C63DD"; // PancakeStableSwap USDT/USDC, kind 7
const V3_USDC = "0x92b7807bF19b7DDdf89b706143896d05228f3121"; // Pancake V3 USDT/USDC 0.01%, kind 2
const BLOCK_B = 69832094 - 1;
const STABLE_ABI = [
    "function coins(uint256) view returns (address)",
    "function balances(uint256) view returns (uint256)",
    "function A() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function FEE_DENOMINATOR() view returns (uint256)",
    "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external",
];

// ---------------------------------------------------------------------------------------
// The combos: drivers {V2, V3, V4, INFI} (the flash-capable kinds) x
// sinks {V2, V3, V4, INFI, CURVE, STABLE, ROUTE}. Same-kind diagonal needs TWO distinct
// real pools of that kind on the SAME pair/block: only V4 has two (DEEP + NATIVE), so
// V4->V4 is real; V2->V2/V3->V3/INFI->INFI are not. CURVE (kind 5) has no real pool at
// all. STABLE and ROUTE each have exactly one real shared-pair combo. This table is the
// enumeration of record: the meta-test below asserts its shape (15 real, 13 skipped,
// no silent gaps); each `real: true` row has its own full `it()` in the Group A/B/C
// describes below (not templated off this table, since their bodies differ too much to
// templatize safely across protocols), and each `real: false` row generates a logged
// pending test straight from this table.
const MATRIX = [
    { driver: "V2", sink: "V2", real: false, reason: "only one real Pancake V2 USDT/WBNB pool at block 103808000" },
    { driver: "V3", sink: "V3", real: false, reason: "only one real Pancake V3 0.01% USDT/WBNB pool at block 103808000" },
    { driver: "V4", sink: "V4", real: true }, // Group A: V4_DEEP drives, V4_NATIVE sinks
    { driver: "INFI", sink: "INFI", real: false, reason: "only one real Pancake Infinity CL USDT/WBNB pool at block 103808000" },
    { driver: "V2", sink: "V3", real: true },
    { driver: "V2", sink: "V4", real: true },
    { driver: "V2", sink: "INFI", real: true },
    { driver: "V3", sink: "V2", real: true },
    { driver: "V3", sink: "V4", real: true },
    { driver: "V3", sink: "INFI", real: true },
    { driver: "V4", sink: "V2", real: true },
    { driver: "V4", sink: "V3", real: true },
    { driver: "V4", sink: "INFI", real: true },
    { driver: "INFI", sink: "V2", real: true },
    { driver: "INFI", sink: "V3", real: true },
    { driver: "INFI", sink: "V4", real: true },
    { driver: "V2", sink: "CURVE", real: false, reason: "no real kind-5 Curve pool on any BSC fork block we have" },
    { driver: "V3", sink: "CURVE", real: false, reason: "no real kind-5 Curve pool on any BSC fork block we have" },
    { driver: "V4", sink: "CURVE", real: false, reason: "no real kind-5 Curve pool on any BSC fork block we have" },
    { driver: "INFI", sink: "CURVE", real: false, reason: "no real kind-5 Curve pool on any BSC fork block we have" },
    { driver: "V2", sink: "STABLE", real: false, reason: "no real V2 pool sharing the stableswap's USDT/USDC pair" },
    { driver: "V3", sink: "STABLE", real: true }, // Group B: stable can't flash; alt (V3) drives, defended (STABLE) sinks
    { driver: "V4", sink: "STABLE", real: false, reason: "no real V4 pool sharing the stableswap's USDT/USDC pair" },
    { driver: "INFI", sink: "STABLE", real: false, reason: "no real Infinity pool sharing the stableswap's USDT/USDC pair" },
    { driver: "V2", sink: "ROUTE", real: true }, // Group C: V2 (WBNB/CAKE) drives, the 2-hop route sinks
    { driver: "V3", sink: "ROUTE", real: false, reason: "no real 2-hop route sharing a pair with a V3-defended pool" },
    { driver: "V4", sink: "ROUTE", real: false, reason: "no real 2-hop route sharing a pair with a V4-defended pool" },
    { driver: "INFI", sink: "ROUTE", real: false, reason: "no real 2-hop route sharing a pair with an INFI-defended pool" },
];

describeFork("VanHelsing fork execution matrix: enumeration", function () {
    it("accounts for every driver x sink cell: 15 real, 13 skipped, no silent gaps", function () {
        expect(MATRIX.length, "4 drivers x 7 sink kinds").to.equal(28);
        const real = MATRIX.filter((c) => c.real);
        const skipped = MATRIX.filter((c) => !c.real);
        expect(real.length).to.equal(15);
        expect(skipped.length).to.equal(13);
        for (const c of skipped) {
            expect(c.reason, `${c.driver}->${c.sink} needs a logged reason`).to.be.a("string");
            expect(c.reason.length, `${c.driver}->${c.sink} needs a non-empty reason`).to.be.gt(0);
        }
    });

    // One logged (pending) test per impossible cell: visible in the run output, not a
    // silent gap. Executed test bodies for the 15 real cells live in the Group A/B/C
    // describes below.
    for (const c of MATRIX.filter((c) => !c.real)) {
        it(`SKIP ${c.driver} -> ${c.sink}: ${c.reason}`, function () {
            this.skip();
        });
    }
});

// Compute `dir` (the ACTUAL driver's own zeroForOne) exactly as measure-sweep.test.js's
// identical helper does: replay the shipped meet once, purely to know which way to drive.
// captureFraction never derives `dir` itself; every caller computes it beforehand.
async function computeDir(h, defended, alt) {
    const dn = await legNormalize(h, defended), an = await legNormalize(h, alt);
    const ld = dn.l ?? await concLegL(h, defended, an.s);
    const la = an.l ?? await concLegL(h, alt, dn.s);
    const [nd, dd] = feeND(defended), [na, da] = feeND(alt);
    const [sdF, saF] = await h.mp.meetBoth(dn.s, ld, nd, dd, an.s, la, na, da);
    const { driver } = resolveDriver(defended, alt);
    const driverIsDef = driver === defended;
    return (driverIsDef ? dn.s : an.s) > (driverIsDef ? sdF : saF);
}

// =========================================================================================
// Group A: the driver x sink grid on the USDT/WBNB pair, block 103808000 (13 real cells:
// 12 off-diagonal + V4->V4). Every cell's skew dumps WBNB into the DRIVER (raising its
// price), so every cell shares the same restore direction (price driven back down).
// =========================================================================================
describeFork("Group A: USDT/WBNB pair (block 103808000), driver x sink grid", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        this.timeout(600000);
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK_A } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const uniHelper = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
        const infiHelper = await deploy(conn, "InfinityLibHarness", null, [], { libraries: { InfinityLib: null } });
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const v4depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const h = { mp, v3depth, v4depth, conn };
        return { registry, vh, uniHelper, infiHelper, h };
    }

    // Skew helpers (front-run), reused verbatim in shape from univ4-fork.test.js /
    // infinity-fork.test.js: dump WBNB in, raising the pool's price.
    async function skewV2(amount) {
        const p = new ethers.Contract(V2_PANCAKE, ["function sync() external"], ethers.provider);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(V2_PANCAKE, amount);
        await p.connect(whale).sync();
    }

    async function skewV3(amount) {
        const poker = await deploy(conn, "PoolPoker");
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(await poker.getAddress(), amount);
        await poker.poke(V3_DEEP, false, amount);
    }

    async function skewV4(uniHelper, amount, cfg) {
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(await uniHelper.getAddress(), amount);
        await uniHelper.swapOnce(cfg, false, amount);
    }

    async function skewInfi(infiHelper, amount) {
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(await infiHelper.getAddress(), amount);
        await infiHelper.swapOnce(CFG_INFI, false, amount);
    }

    // Model builders for the capture spot-check: real concModel/v2Model off LIVE fork
    // state, with a generous (not wei-tuned) tick band. A loose spot-check, not the
    // wei-exact GATE 1/GATE 2 calibrations in measure-conc.test.js.
    async function v2ModelOf(addr) {
        const p = new ethers.Contract(addr, ["function getReserves() view returns (uint112,uint112,uint32)"], ethers.provider);
        const [r0, r1] = await p.getReserves();
        return v2Model(r0, r1, 9975n, 10000n);
    }

    async function v3ModelOf(addr, feeNum, feeDen) {
        const v3 = new ethers.Contract(addr, V3_ABI, ethers.provider);
        const s0 = await v3.slot0();
        const spotL = await v3.liquidity();
        const spacing = Number(await v3.tickSpacing());
        const sqrtP = clampSqrt(BigInt(s0.sqrtPriceX96));
        const spotTick = Number(s0.tick);
        // A narrow band (as in measure-conc.test.js's GATE 1, which used +-30..40 compressed
        // ticks for this exact pool): a WIDE band over a deep, actively-LPed 0.01% pool can
        // hit a dense cluster of initialized ticks, turning the bitmap scan + per-tick reads
        // into thousands of sequential remote-archive RPC calls (empirically, +-1000 hung
        // for 10+ minutes where +-60 is fast). This pool barely moves even at a few hundred
        // WBNB (GATE 1: crossed=0 at 120 WBNB), so +-60 is still a generous margin.
        const band = await readV3Ticks(ethers.provider, addr, spacing, spotTick - 60 * spacing, spotTick + 60 * spacing);
        return concModel(sqrtP, spotTick, spacing, band, feeNum, feeDen, spotL);
    }

    // V4_DEEP is much shallower beyond its core range than V3_DEEP, so a front-run of the
    // same order of magnitude used elsewhere in this file (hundreds of WBNB) can drive its
    // price a long way from spot (many thousands of ticks) before meeting the alt. A FIXED
    // tick band around spot cannot size itself correctly for this: too narrow and the
    // swap-to-target simulation truncates before reaching the real target; too wide (when
    // guessed without knowing the target) risks reading a huge, mostly-empty range for no
    // reason. So: two-phase, exactly measure-conc.test.js's own GATE 2 pattern. Phase 1 needs
    // no ticks at all: V4's walked L comes from the REAL V4DepthHarness (via concLegL's
    // v4cfg fast path, which reads the live pool directly), so the meeting target is
    // computed from just the spot price plus the OTHER leg's already-known (s, l, fee).
    // Phase 2 reads a band spanning [spot, target] with a safety margin, sized to what THIS
    // drive actually needs instead of a guessed constant.
    //
    // `other` is the partner leg's own (s, l, feeNum, feeDen), or null when the partner has
    // no model at all (INFI/native), in which case no spot-check will be attempted, so
    // this returns null too rather than spending RPC calls on an unused model.
    async function v4TargetedModel(h, other) {
        if (!other) return null;
        const feeNum = 999500n, feeDen = 1000000n; // V4_DEEP, 0.05%
        const cfg = CFG_DEEP, poolId = idV4(V4_DEEP), spacing = 10;
        const { sqrtP: sRaw, tick: spotTick, liq: spotL } = await readV4Slot0Liq(ethers.provider, poolId);
        const sqrtP = clampSqrt(sRaw);
        const probe = concModel(sqrtP, spotTick, spacing, [], feeNum, feeDen, spotL, cfg);
        const ld = await concLegL(h, probe, other.s);
        // V4 always occupies the "sd" slot here regardless of its actual driver/alt role in
        // the outer cell: MeetingPrice.meet is symmetric in its two legs (swapping which
        // leg is "d" and which is "a" just swaps which of sdF/saF comes back, not the
        // values), the same assumption computeDir above already relies on.
        const [sdF] = await h.mp.meetBoth(sqrtP, ld, feeNum, feeDen, other.s, other.l, other.feeNum, other.feeDen);
        const target = clampSqrt(BigInt(sdF));
        const targetTick = tickAtSqrt(target);
        const lo = Math.min(spotTick, targetTick) - 300, hi = Math.max(spotTick, targetTick) + 300;
        const band = await readV4Ticks(ethers.provider, poolId, spacing, lo, hi);
        return concModel(sqrtP, spotTick, spacing, band, feeNum, feeDen, spotL, cfg);
    }

    // The other leg's (s, l, feeNum, feeDen), for v4TargetedModel. `m` may be null (no
    // model: INFI/native), in which case this is null too.
    async function legInfo(h, m, otherSqrt) {
        if (!m) return null;
        const n = await legNormalize(h, m);
        const l = n.l ?? await concLegL(h, m, otherSqrt);
        return { s: n.s, l, feeNum: m.feeNum, feeDen: m.feeDen };
    }

    // Per-kind adapters: entry() for registry.setPools, skew() to front-run, price()
    // for a same-kind before/after comparable, model() for the capture spot-check (null
    // when not cheaply/correctly constructible; logged, not silently dropped).
    const adapterV2 = {
        kind: "V2",
        defaultSkew: 300n * ONE,
        async entry() { return [ID_V2, 0, 25, 0]; },
        async skew(fx, amount) { await skewV2(amount); },
        async price() { const [, r1] = await new ethers.Contract(V2_PANCAKE, ["function getReserves() view returns (uint112,uint112,uint32)"], ethers.provider).getReserves(); return r1; },
        async model() { return v2ModelOf(V2_PANCAKE); },
    };
    const adapterV3 = {
        kind: "V3",
        defaultSkew: 600n * ONE,
        async entry() { return [ID_V3, 2, 100, 0]; },
        async skew(fx, amount) { await skewV3(amount); },
        async price() { const v3 = new ethers.Contract(V3_DEEP, V3_ABI, ethers.provider); return (await v3.slot0()).sqrtPriceX96; },
        async model() { return v3ModelOf(V3_DEEP, 999900n, 1000000n); },
    };
    const adapterV4Deep = {
        kind: "V4",
        defaultSkew: 400n * ONE, // matches univ4-fork.test.js's own skew for this pool
        async entry(fx) { const id = await registerV4(fx.registry, V4_DEEP); return [id, 4, 500, 0]; },
        async skew(fx, amount) { await skewV4(fx.uniHelper, amount, CFG_DEEP); },
        async price(fx) { const [s] = await fx.uniHelper.normalize(CFG_DEEP); return s; },
        // No plain model(): runCell always builds V4_DEEP's spot-check model through the
        // target-aware v4TargetedModel (see its comment above), never a fixed band, since
        // V4_DEEP is shallow enough that a fixed guess cannot cover both "V4 sits still as
        // the alt" and "V4 itself gets driven back" at once.
        needsTargetedModel: true,
    };
    const adapterV4Native = {
        kind: "V4-native",
        async entry(fx) { const id = await registerV4(fx.registry, V4_NATIVE); return [id, 4, 500, 0]; },
        // flipped currency space (native currency0): reorienting its raw ticks/sqrtP into
        // the engine's token-space convention needs inversion logic that fork-ticks.js
        // does not have, and it is uncalibrated elsewhere in the suite, so it is logged
        // N/A rather than risk a silently-wrong spot-check.
        async model() { return null; },
    };
    const adapterInfi = {
        kind: "INFI",
        defaultSkew: 10n * ONE,
        async entry(fx) { const id = await registerV4(fx.registry, INFI_NATIVE); return [id, 6, 67, 0]; },
        async skew(fx, amount) { await skewInfi(fx.infiHelper, amount); },
        async price(fx) { const [s] = await fx.infiHelper.normalize(CFG_INFI); return s; },
        // flipped currency space (native currency0): same N/A reasoning as V4-native;
        // Infinity's only real pool on this pair is this native one.
        async model() { return null; },
    };

    const GAS_A = 10_000_000;

    // The generic per-cell runner: register [driver, sink], front-run the driver, ward
    // it, assert the invariants, and (when both legs have a model) the loose capture
    // spot-check. Shared by all 13 Group A `it()`s below.
    //
    // Ordering matters here: the engine's prediction (dir/chosen/chosenProfit) MUST be
    // computed BEFORE vh["ward(bytes32,address)"]() runs, exactly as measure-conc.test.js's
    // GATE 1/GATE 2 calibrations do. A V4 leg's walked L (concLegL's v4cfg fast path) reads
    // the REAL pool's LIVE state, not the frozen JS ticks array: calling it AFTER the ward
    // would read the pool's just-RESTORED state instead of the dislocated state the ward
    // actually acted on, silently mispredicting (this was a real bug caught during
    // development: computing the prediction after the ward read post-restore liquidity for
    // the driven V4 leg, showing up as a ~7-9% mismatch only on V4-driven cells).
    async function runCell(driverAdapter, sinkAdapter, opts = {}) {
        const fx = await loadFixture(deployFixture);
        const { registry, vh, h } = fx;
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const label = `${driverAdapter.kind}->${sinkAdapter.kind}`;

        const driverEntry = await driverAdapter.entry(fx);
        const sinkEntry = await sinkAdapter.entry(fx);
        await registry.setPools(USDT, WBNB, [driverEntry, sinkEntry]);

        const amount = opts.skewAmount ?? driverAdapter.defaultSkew;
        await driverAdapter.skew(fx, amount);
        const priceSkewed = await driverAdapter.price(fx);

        // spot-check models + prediction built off the SAME post-skew, pre-ward state
        // the ward itself reads. V4_DEEP (either side) always goes through the
        // target-aware builder (see v4TargetedModel) instead of its own model(), which
        // it does not have.
        let defModel, altModel;
        if (driverAdapter.needsTargetedModel) {
            altModel = await sinkAdapter.model();
            const other = await legInfo(h, altModel, clampSqrt((await readV4Slot0Liq(ethers.provider, idV4(V4_DEEP))).sqrtP));
            defModel = await v4TargetedModel(h, other);
        } else if (sinkAdapter.needsTargetedModel) {
            defModel = await driverAdapter.model();
            const other = await legInfo(h, defModel, clampSqrt((await readV4Slot0Liq(ethers.provider, idV4(V4_DEEP))).sqrtP));
            altModel = await v4TargetedModel(h, other);
        } else {
            defModel = await driverAdapter.model();
            altModel = await sinkAdapter.model();
        }

        // Predict BEFORE the ward mutates chain state (see the note above).
        let prediction = null;
        if (defModel && altModel) {
            const dir = await computeDir(h, defModel, altModel);
            const { chosenProfit, capture } = await captureFraction(h, defModel, altModel, dir);
            prediction = { dir, chosenProfit, capture };
        }

        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](driverEntry[0], BENEFICIARY, { gasLimit: opts.gas ?? GAS_A });

        const usdtDelta = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore;
        const wbnbDelta = (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        const gain = usdtDelta + wbnbDelta;
        expect(gain, `${label}: a driver front-run should profit`).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress()), `${label}: USDT residue`).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress()), `${label}: WBNB residue`).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress()), `${label}: native residue`).to.equal(0n);

        const priceAfter = await driverAdapter.price(fx);
        expect(priceAfter, `${label}: defended pool should move back toward fair`).to.be.lt(priceSkewed);

        if (prediction) {
            const { dir, chosenProfit, capture } = prediction;
            const [realized, offDelta] = dir ? [usdtDelta, wbnbDelta] : [wbnbDelta, usdtDelta];
            expect(offDelta, `${label}: non-payout token delta should be exactly 0`).to.equal(0n);
            const err = relErr(chosenProfit, realized);
            const bandPct = opts.band ?? 0.05;
            console.log(`  [spot-check ${label}] engine=${chosenProfit} realized=${realized} capture=${(capture * 100).toFixed(2)}% relErr=${(err * 100).toFixed(4)}%`);
            expect(chosenProfit, `${label}: engine predicts no profit`).to.be.gt(0n);
            expect(err, `${label}: engine ${chosenProfit} vs realized ${realized} = ${(err * 100).toFixed(4)}%`).to.be.lte(bandPct);
        } else {
            console.log(`  [spot-check ${label}] SKIPPED (model N/A: flipped/native singleton pool, see adapter comment)`);
        }
    }

    it("V2 -> V3: drives a dislocated V2 pool and sinks into the V3 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV2, adapterV3);
    });
    it("V2 -> V4: drives a dislocated V2 pool and sinks into the V4 alt (nested lock)", async function () {
        this.timeout(600000);
        await runCell(adapterV2, adapterV4Deep);
    });
    it("V2 -> INFI: drives a dislocated V2 pool and sinks into the Infinity CL alt", async function () {
        this.timeout(600000);
        await runCell(adapterV2, adapterInfi);
    });
    it("V3 -> V2: drives a dislocated V3 pool and sinks into the V2 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV3, adapterV2);
    });
    it("V3 -> V4: drives a dislocated V3 pool and sinks into the V4 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV3, adapterV4Deep);
    });
    it("V3 -> INFI: drives a dislocated V3 pool and sinks into the Infinity CL alt", async function () {
        this.timeout(600000);
        await runCell(adapterV3, adapterInfi);
    });
    it("V4 -> V2: drives a dislocated V4 pool and sinks into the V2 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV4Deep, adapterV2);
    });
    it("V4 -> V3: drives a dislocated V4 pool and sinks into the V3 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV4Deep, adapterV3);
    });
    it("V4 -> INFI: drives a dislocated V4 pool and sinks into the Infinity CL alt", async function () {
        this.timeout(600000);
        await runCell(adapterV4Deep, adapterInfi);
    });
    it("INFI -> V2: drives a dislocated Infinity CL pool and sinks into the V2 alt", async function () {
        this.timeout(600000);
        await runCell(adapterInfi, adapterV2);
    });
    it("INFI -> V3: drives a dislocated Infinity CL pool and sinks into the V3 alt", async function () {
        this.timeout(600000);
        await runCell(adapterInfi, adapterV3);
    });
    it("INFI -> V4: drives a dislocated Infinity CL pool and sinks into the V4 alt", async function () {
        this.timeout(600000);
        await runCell(adapterInfi, adapterV4Deep);
    });
    it("V4 -> V4(native): restores a WBNB/USDT V4 pool against a deep native-BNB/USDT V4 alt", async function () {
        this.timeout(600000);
        await runCell(adapterV4Deep, adapterV4Native);
    });
});

// =========================================================================================
// Group B: stable-defended (alt drives) on the USDT/USDC pair, block 69832094-1. The
// stableswap can never flash (CurveLib.sol), so ward(STABLE) drives the V3 alt and sinks
// into the stableswap: the resolveDriver rule. This is the SAME physical cell as
// "V3 -> STABLE" in the driver x sink grid (which id you ward does not change which pool
// actually drives; see curve-fork.test.js).
// =========================================================================================
describeFork("Group B: USDT/USDC pair (block 69832094-1), stable-defended (alt drives)", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        this.timeout(600000);
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK_B } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    it("V3 -> STABLE: stableswap can't flash; ward(STABLE) drives the V3 alt, stableswap sinks", async function () {
        this.timeout(600000);
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const curveLib = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
        const h = { mp, v3depth, curveLib, conn };

        const usdt = await ethers.getContractAt("IERC20", USDT);
        const usdc = await ethers.getContractAt("IERC20", USDC);
        const stableRO = new ethers.Contract(STABLE, STABLE_ABI, ethers.provider);
        const v3RO = new ethers.Contract(V3_USDC, V3_ABI, ethers.provider);
        const [stableFeeRaw, feeDen, v3FeeRaw] = await Promise.all([stableRO.fee(), stableRO.FEE_DENOMINATOR(), v3RO.fee()]);

        await registry.setPools(USDT, USDC, [
            [idAddr(V3_USDC), 2, v3FeeRaw, 0],
            [idAddr(STABLE), 7, stableFeeRaw, 0],
        ]);

        // front-run: dump USDT into the stableswap (verbatim from curve-fork.test.js). A=1000
        // is very flat, so a large imbalance is needed to move it off the V3 anchor.
        const holder = "0x36696169c63e42cd08ce11f5deebbcebae652050";
        await networkHelpers.impersonateAccount(holder);
        await networkHelpers.setBalance(holder, 100n * ONE);
        const whale = await ethers.getSigner(holder);
        const fr = 200_000n * ONE;
        const stableRW = new ethers.Contract(STABLE, STABLE_ABI, whale);
        await usdt.connect(whale).approve(STABLE, fr);
        await stableRW.exchange(0, 1, fr, 0);
        await networkHelpers.stopImpersonatingAccount(holder);

        // spot-check models off the SAME post-front-run state the ward reads.
        const [b0, b1, A] = await Promise.all([stableRO.balances(0), stableRO.balances(1), stableRO.A()]);
        const stableFeeNum = feeDen - stableFeeRaw;
        const defModel = stableModel(b0, b1, A, stableFeeNum, feeDen, { pool: STABLE, t0: USDT, t1: USDC, curveKind: 7 });

        const [s0, spotL, spacingRaw] = await Promise.all([v3RO.slot0(), v3RO.liquidity(), v3RO.tickSpacing()]);
        const spacing = Number(spacingRaw);
        const sqrtP = BigInt(s0.sqrtPriceX96);
        const spotTick = Number(s0.tick);
        const feeNumV3 = 1_000_000n - v3FeeRaw, feeDenV3 = 1_000_000n;
        // Band width matches measure-stable.test.js's own CALIBRATION (b) exactly (50
        // compressed ticks each side), proven fast for this exact pool; a much wider band
        // risks a dense-tick-cluster hang (see the note in Group A's v3ModelOf above).
        const band = await readV3Ticks(ethers.provider, V3_USDC, spacing, spotTick - 50 * spacing, spotTick + 50 * spacing);
        const altModel = concModel(sqrtP, spotTick, spacing, band, feeNumV3, feeDenV3, spotL);

        // dir: the stableswap can never drive, so the ALT (V3) is the actual driver and
        // dir/target are its OWN (current, final), as VanHelsing._pickDriver flips to the
        // alt when the defended can't flash (see measure-stable.test.js's identical
        // meetAndDirStable).
        const { s: sd, l: ld } = await stableNormalize(h, defModel);
        const sa = clampSqrt(sqrtPriceOf(altModel));
        const la = await concLegL(h, altModel, sd);
        const [, saF] = await h.mp.meetBoth(clampSqrt(sd), ld, defModel.feeNum, defModel.feeDen, sa, la, altModel.feeNum, altModel.feeDen);
        const dir = sa > clampSqrt(saF);

        // capture spot-check prediction: MUST be computed BEFORE the ward runs. The
        // stable leg's own (s, l) comes from CurveLib's price and depth reading the REAL
        // pool's LIVE balances (stableNormalize, via legNormalize inside captureFraction):
        // calling this after the ward would read the balances the ward's own sink just
        // changed, not the front-run-dislocated state it actually acted on (the same
        // class of bug the Group A comment describes for a V4 leg's live-read L).
        // LOGGED, not tightly gated: a stable-defended cell's tangent adequacy is what we
        // observe, not assert (CurveLib's near-peg tangent depth is not wei-exact; see
        // curve-fork.test.js and measure-stable.test.js).
        const { chosenProfit, capture } = await captureFraction(h, defModel, altModel, dir);

        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const usdcBefore = await usdc.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(STABLE), BENEFICIARY, { gasLimit: 6_000_000 })).to.not.be.revert(ethers);

        const dUsdt = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore;
        const dUsdc = (await usdc.balanceOf(BENEFICIARY)) - usdcBefore;
        const [realized, offDelta] = dir ? [dUsdt, dUsdc] : [dUsdc, dUsdt];

        expect(dUsdt >= 0n && dUsdc >= 0n, "fundless: neither beneficiary balance may fall").to.equal(true);
        expect(offDelta, "non-payout token delta should be exactly 0").to.equal(0n);
        expect(realized, "a driver front-run should profit").to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdc.balanceOf(await vh.getAddress())).to.equal(0n);

        // invariant #3 (loose): the defended stableswap's balances after the ward, vs its
        // post-front-run balances (b0/b1 above, read before the ward). The front-run dumped
        // USDT (coin 0) in and pulled USDC (coin 1) out, so a restore toward peg should push
        // b0 back down and b1 back up. A stable leg's tangent adequacy is observed, not
        // tightly asserted (CurveLib's near-peg tangent depth is not wei-exact), so this is
        // logged, not gated, unlike Group A/C's plain V2/V3/V4 pools which hard-assert this
        // same direction.
        const [b0After, b1After] = await Promise.all([stableRO.balances(0), stableRO.balances(1)]);
        console.log(`  [invariant-3 V3->STABLE] balances before=(${b0}, ${b1}) after=(${b0After}, ${b1After}): USDT should trend down, USDC up, toward peg`);

        const err = relErr(chosenProfit, realized);
        console.log(`  [spot-check V3->STABLE] engine=${chosenProfit} realized=${realized} capture=${(capture * 100).toFixed(2)}% relErr=${(err * 100).toFixed(4)}% (logged only, no gate)`);
        expect(chosenProfit, "engine should also predict a profitable direction").to.be.gt(0n);
    });
});

// =========================================================================================
// Group C: V2 driver, ROUTE sink (X -> USDT -> WBNB 2-hop route) on the WBNB/CAKE pair,
// block 103808000. Reuses route-fork.test.js's exact registration/skew.
// =========================================================================================
describeFork("Group C: V2 driver -> ROUTE sink (CAKE triangular route, block 103808000)", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        this.timeout(600000);
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK_A } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const v4depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const routeLib = await deploy(conn, "RouteLibHarness", null, [], { libraries: { V3Depth: null, V4Depth: null, RouteLib: null } });
        const h = { mp, v3depth, v4depth, routeLib, conn };

        // Route for pair (WBNB, X) via USDT: hop1 = (t0, USDT), hop2 = (USDT, t1) where
        // (t0,t1)=sorted(WBNB, X), verbatim from route-fork.test.js.
        const v4Id = await registerV4(registry, V4_HOP); // USDT/WBNB
        const v3Id = idAddr(HOP_V3); // X/USDT
        const wLo = WBNB.toLowerCase(), xLo = X.toLowerCase();
        const [t0] = wLo < xLo ? [WBNB] : [X];
        const hop1Id = t0.toLowerCase() === wLo ? v4Id : v3Id;
        const hop2Id = t0.toLowerCase() === wLo ? v3Id : v4Id;

        await registry.setPools(USDT, WBNB, [[v4Id, 4, 500, 0]]);
        await registry.setPools(X, USDT, [[v3Id, 2, V3_FEE_HOP, 0]]);
        const routeId = idRoute(hop1Id, hop2Id);
        await registry.setPools(WBNB, X, [[idAddr(P1_V2), 0, 25, 0], [routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(hop1Id, hop2Id, USDT));

        return { registry, vh, routeId, h };
    }

    async function skewV2Wbnb(pair, amount) {
        const p = new ethers.Contract(pair, ["function sync() external"], ethers.provider);
        const [whale] = await ethers.getSigners();
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await p.connect(whale).sync();
    }

    it("V2 -> ROUTE: restores a front-run V2 pool by sinking WBNB -> USDT -> X (V4 then V3, nested lock)", async function () {
        this.timeout(600000);
        const { registry, vh, routeId, h } = await loadFixture(deployFixture);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const x = await ethers.getContractAt("IERC20", X);
        const usdt = await ethers.getContractAt("IERC20", USDT);

        await skewV2Wbnb(P1_V2, 300n * ONE);

        // spot-check models off the SAME post-skew state the ward reads: defended = P1_V2
        // (v2), hop1 = HOP_V3 (X/USDT), hop2 = V4_HOP (USDT/WBNB); both plain/aligned
        // pools (no native-currency flip), so unlike the Group A INFI/native cells, this
        // route's spot-check IS cheaply constructible with capture.js's route-aware
        // machinery (routeNormalize/routeLegL/captureFractionRoute) + the shared
        // fork-tick readers (fork-ticks.js).
        const p1 = new ethers.Contract(P1_V2, ["function getReserves() view returns (uint112,uint112,uint32)"], ethers.provider);
        const [r0, r1] = await p1.getReserves(); // P1_V2 pair sort: X < WBNB -> token0=X, token1=WBNB
        const defModel = v2Model(r0, r1, 9975n, 10000n);

        const hopV3 = new ethers.Contract(HOP_V3, V3_ABI, ethers.provider);
        const [s0Hop, spotLHop, spacingRawHop] = await Promise.all([hopV3.slot0(), hopV3.liquidity(), hopV3.tickSpacing()]);
        const spacingHop = Number(spacingRawHop);
        const spotTickHop = Number(s0Hop.tick);
        const feeNumHop = 1_000_000n - BigInt(V3_FEE_HOP), feeDenHop = 1_000_000n;
        // Narrow band (60 compressed ticks each side; see the note in Group A's
        // v3ModelOf): a wide band over a real, actively-LPed V3 pool risks hitting a dense
        // tick cluster, turning the scan into thousands of sequential archive RPC calls.
        const bandHop = await readV3Ticks(ethers.provider, HOP_V3, spacingHop, spotTickHop - 60 * spacingHop, spotTickHop + 60 * spacingHop);
        const hop1Model = concModel(BigInt(s0Hop.sqrtPriceX96), spotTickHop, spacingHop, bandHop, feeNumHop, feeDenHop, spotLHop);

        const v4HopId = idV4(V4_HOP);
        const { sqrtP: sRaw4, tick: spotTick4, liq: spotL4 } = await readV4Slot0Liq(ethers.provider, v4HopId);
        const band4 = await readV4Ticks(ethers.provider, v4HopId, 10, spotTick4 - 3000, spotTick4 + 3000);
        const hop2Model = concModel(clampSqrt(sRaw4), spotTick4, 10, band4, 999500n, 1000000n, spotL4, configV4(V4_HOP));

        // dir1/dir2: each hop's own near->far zeroForOne, by address sort, exactly
        // measure-sweep.test.js's buildHopPool convention (near==token0 -> zeroForOne=true).
        const dir1 = X.toLowerCase() < USDT.toLowerCase(); // hop1 near=X(t0), far=USDT(mid)
        const dir2 = USDT.toLowerCase() < WBNB.toLowerCase(); // hop2 near=USDT(mid), far=WBNB(t1)

        // dir: the route can never drive (routes never flash), so the defended V2 pool is
        // always the driver; this matches vanHelsingRouteDriveSize's own internal derivation.
        const route = { reg: await registry.getAddress(), routeId };
        const dn = await legNormalize(h, defModel);
        const an = await routeNormalize(h, route);
        const laRoute = await routeLegL(h, route, dn.s);
        const [sdF] = await h.mp.meetBoth(dn.s, dn.l, defModel.feeNum, defModel.feeDen, an.s, laRoute, an.fn, an.fd);
        const dir = dn.s > clampSqrt(BigInt(sdF));

        // route spot-check prediction: MUST be computed BEFORE the ward runs. The
        // route's own (s, l) comes from RouteLib.normalize/effectiveLiquidity reading
        // the REAL hop pools' LIVE state: the ward's own sink trades through both hops
        // to restore P1_V2, so calling this after the ward would read the hops'
        // POST-sink state, not the state the drive actually sized against (the same
        // class of bug the Group A comment describes for a V4 leg's live-read L).
        const r = await captureFractionRoute(h, defModel, route, hop1Model, hop2Model, dir, dir1, dir2);

        const beneW = await wbnb.balanceOf(BENEFICIARY);
        const beneX = await x.balanceOf(BENEFICIARY);
        const rc = await (await vh["ward(bytes32,address)"](idAddr(P1_V2), BENEFICIARY, { gasLimit: 12_000_000 })).wait();

        const captured = rc.logs
            .map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "Captured");
        expect(captured.args.anchor, "the sink really was the route").to.equal(routeId);

        const dW = (await wbnb.balanceOf(BENEFICIARY)) - beneW;
        const dX = (await x.balanceOf(BENEFICIARY)) - beneX;
        const gain = dW + dX;
        expect(gain, "a driver front-run should profit").to.be.gt(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await x.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);

        // invariant #3: the defended pool (P1_V2, Pancake V2) moved back toward fair. The
        // front-run dumped WBNB into P1_V2 (token1, since X < WBNB by address sort; see
        // the getReserves read above), inflating the WBNB reserve. This follows Group A's V2
        // adapter's own price() direction exactly (whichever reserve the front-run inflated
        // must decrease after the restore), and is a hard assert, not a log, since P1_V2 is
        // a plain V2 pool like Group A's, not a stable/route model needing relaxation.
        const [, r1After] = await p1.getReserves();
        expect(r1After, "V2->ROUTE: defended pool (P1_V2) should move back toward fair").to.be.lt(r1);

        // LOGGED, not tightly gated: a route sizes a much smaller slice of the gap than
        // a direct leg, so the realized profit is small and relatively more sensitive to
        // the tick-band width than a direct concentrated leg's spot-check.
        const realized = dX !== 0n ? dX : dW; // whichever token RouteLib.payoutRoute chose
        const err = relErr(r.chosenProfit, realized);
        console.log(`  [spot-check V2->ROUTE] engine=${r.chosenProfit} realized=${realized} (dW=${dW} dX=${dX}) capture=${(r.capture * 100).toFixed(2)}% relErr=${(err * 100).toFixed(4)}% (logged only, no gate)`);
        expect(r.chosenProfit, "engine should also predict a profitable direction").to.be.gt(0n);
    });
});
