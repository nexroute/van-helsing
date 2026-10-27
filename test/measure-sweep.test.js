import { network } from "hardhat";
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "./helpers/ids.js";
import { Q96, sqrtAtTick, tickAtSqrt, v2Model, concModel, stableModel, stableOut, stableNormalizeModel, isqrt, sqrtPriceOf, Q192 } from "./lib/pool-model.js";
import {
    captureFraction, concLegL, legNormalize, feeND, resolveDriver,
    routeNormalize, routeLegL, captureFractionRoute, capStableL,
} from "./lib/capture.js";
import { describeFork } from "./helpers/fork.js";

// The full capture-quality grid sweep and its report. Fork-free by design: every leg is a
// mock or a pure-BigInt model, sized through the SAME shipped harnesses (MeetingPriceHarness,
// V3DepthHarness, RouteLibHarness) as the calibration runs in measure-v2, measure-conc and
// measure-stable.test.js. The test below writes the measured results to
// docs/measurements/vanhelsing-capture.md; this file only builds the grid and writes that report.

const ONE = 10n ** 18n;
// Absolute-depth axis (a {small, normal, huge} depth scale): the defended leg's reference
// depth per slice; the alt leg is this scaled by the depth ratio. Sweeping it, rather than
// fixing it at 1e24 and varying only the leg RATIO, is what separates scale effects from
// scale-free ones. Values picked to exercise both precision extremes without leaving the
// shipped contracts' numeric range: at 1e28 the deepest alt leg (ratio 1e3) is 1e31, which
// fits MockV3TickPool's uint128 spotL / int128 liqNet, and the stableswap's amplified tangent
// L (~1e3x nominal, scale-invariant because the curve is homogeneous) keeps every
// MeetingPrice.meet term far inside uint256; at 1e20 the shallowest alt leg (ratio 1e-3) is
// 1e17, small enough that per-wei rounding becomes a visible fraction of the smallest profits
// (the precision floor the small slice is there to measure).
const BASE_LS = [
    { label: "1e20", L: 10n ** 20n },
    { label: "1e24", L: 10n ** 24n },
    { label: "1e28", L: 10n ** 28n },
];
const ROUTE_BASE_L = 10n ** 24n; // route sub-grid stays on the middle slice (disclosed in its section)
const ANCHOR_SQRT = Q96; // "fair" 1:1 reference price shared by every pair's anchor leg

// Precision floor for a POSITIVE optimum: below 1e-12 of the slice's defended depth it
// is integer-rounding dust, not a genuine arb. The engine's per-swap rounding (outputs
// floored, fee round-ups) leaves a wei-scale sawtooth on the profit curve that GROWS
// with absolute depth (measured 21-47 wei at the 1e28 slice, ~1e-21 of depth); on grid
// points whose exact optimum is ~0 (the fee-kick geometry of mechanism (A), see
// classifyOvershoots) that noise can cross the optimalProfit > 0 classification threshold
// and masquerade as a tiny "real arb". The floor tags those instead of silently
// reclassifying them: every count and list still carries them, labeled. 1e-12 sits orders
// of magnitude above the observed noise (~1e-21 relative) and orders below the smallest
// genuine optimum this grid produces (~4e-9 of depth); the report prints both live so the
// margin is checkable.
const DUST_DIV = 10n ** 12n;
const baseLOf = (label) => BASE_LS.find((b) => b.label === label).L;
const isDust = (p) => p.optimalProfit > 0n && p.optimalProfit < baseLOf(p.baseL) / DUST_DIV;
// isDust's counterpart for mechanism (A): its points have optimalProfit <= 0 BY DEFINITION
// (that is what makes them "no-arb-attempted"), so a floor on optimalProfit would tag
// nothing. The realized loss there is chosenProfit (always < 0n, by overshoot's own
// definition), so the floor applies to |chosenProfit| instead: the same DUST_DIV bar,
// the other side of the ledger.
const isDustA = (p) => -p.chosenProfit < baseLOf(p.baseL) / DUST_DIV;

// The tiny-stable-pool probe finding (surfaced by the 1e20 slice; see the report's
// Absolute-depth slices section): CurveLib used to price a stableswap off a FIXED
// 1e18-wei unit quote, which stopped being marginal at balances <= 1e20 wei (<= 100
// tokens): >= 1% of the pool, 10x the whole pool at 1e17, and at exactly 1e20 it
// coincided with the b0/100 depth reference, collapsing the fit's denominator to
// rounding noise. CurveLib.price now scales the quote to min(1e18, b0/1000), which
// removed those regimes (the report's Tiny-depth section shows the live values).
// These helpers still identify points whose stable leg sits at or below that balance,
// so the report can count that cluster and tag it with a materiality note.
const PROBE_BALANCE_CEIL = 10n ** 20n;
function stableBalanceOf(p) {
    if (!p.pair.includes("stable")) return null;
    const L = baseLOf(p.baseL);
    if (p.pair.startsWith("stable")) return L; // stable in the defended slot: depth = BASE_L
    const r = DEPTH_RATIOS.find((d) => d.label === p.depthRatio);
    return (L * r.num) / r.den; // stable in the alt slot: depth = BASE_L * ratio
}
const isTinyStableProbe = (p) => {
    const b = stableBalanceOf(p);
    return b !== null && b <= PROBE_BALANCE_CEIL;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The repository root is one level up from test/.
const REPORT_PATH = path.resolve(__dirname, "../docs/measurements/vanhelsing-capture.md");

// ---------------------------------------------------------------------------
// Grid definitions
// ---------------------------------------------------------------------------

// defended x alt model pairs. A stable defended forces the alt to drive: captureFraction
// (via resolveDriver) handles which leg actually drives, and this list only fixes which
// KIND sits in which slot.
const PAIRS = [
    { label: "V2/V2", defKind: "v2", altKind: "v2" },
    { label: "V2/conc", defKind: "v2", altKind: "conc" },
    { label: "conc/conc", defKind: "conc", altKind: "conc" },
    { label: "conc/V2", defKind: "conc", altKind: "v2" },
    { label: "conc/stable", defKind: "conc", altKind: "stable" },
    { label: "stable/conc", defKind: "stable", altKind: "conc" },
    { label: "V2/stable", defKind: "v2", altKind: "stable" },
];

// alt L / def L.
const DEPTH_RATIOS = [
    { label: "1e-3", num: 1n, den: 1000n },
    { label: "1e-1", num: 1n, den: 10n },
    { label: "1", num: 1n, den: 1n },
    { label: "1e1", num: 10n, den: 1n },
    { label: "1e3", num: 1000n, den: 1n },
];

// sqrt-price bump of the dislocated leg away from the anchor leg.
const DISLOCATIONS = [
    { label: "0.05%", num: 5n, den: 10000n },
    { label: "0.5%", num: 5n, den: 1000n },
    { label: "2%", num: 2n, den: 100n },
    { label: "10%", num: 10n, den: 100n },
    { label: "50%", num: 50n, den: 100n },
];

// concentrated depth shapes (only meaningful when a leg is conc). D/T keep the same
// 10000:1 ratio as the calibrated cliffy constructions in depth-budget.test.js /
// bounded-walk.test.js; D is this leg's characteristic (core) depth, passed in as `L`.
const SHAPES = ["uniform", "mild-cliff", "sharp-cliff", "thin-active"];

const V2_FEES = [
    { label: "0.25%", num: 9975n, den: 10000n },
    { label: "0% (control)", num: 10000n, den: 10000n },
];
const CONC_FEES = [
    { label: "0.05%", num: 999500n, den: 1000000n },
    { label: "1%", num: 990000n, den: 1000000n },
    { label: "0% (control)", num: 1000000n, den: 1000000n },
];
const STABLE_FEES = [
    { label: "0.04%", num: 9996000000n, den: 10000000000n },
    { label: "0% (control)", num: 10000000000n, den: 10000000000n },
];
function feesFor(kind) { return kind === "v2" ? V2_FEES : kind === "conc" ? CONC_FEES : STABLE_FEES; }

// Fee scenarios per pair (applied per leg's own kind): typical (each leg's cheapest/most
// common fee), stress (the conc leg's higher 1% tier where a leg is conc), zero-control
// (both legs fee-free). Keeps each absolute-depth slice to ~1-2k points instead of a full
// fee x fee cross for every pair.
//
// "stress" only differs from "typical" when at least one leg is conc (it substitutes that
// leg's higher CONC_FEES[1] tier); a pair with neither leg conc (V2/V2, V2/stable) has no
// higher tier to substitute, so its `stress` would be built from the same two fee objects
// as `typical` and count the same 25 grid points per pair (5 depthRatio x 5 dislocation x
// 1 shape) twice. Those objects are reference-equal to `typical`'s own (not fresh copies),
// so `!==` below is an exact, not approximate, dedup: skip `stress` there rather than
// invent an uncalibrated third V2/stable fee tier just to force a difference.
function feeScenarios(pair) {
    const df = feesFor(pair.defKind), af = feesFor(pair.altKind);
    const typical = { label: "typical", def: df[0], alt: af[0] };
    const stress = { label: "stress", def: pair.defKind === "conc" ? CONC_FEES[1] : df[0], alt: pair.altKind === "conc" ? CONC_FEES[1] : af[0] };
    const zeroControl = { label: "zero-control", def: df[df.length - 1], alt: af[af.length - 1] };
    const scenarios = [typical, zeroControl];
    if (stress.def !== typical.def || stress.alt !== typical.alt) scenarios.splice(1, 0, stress);
    return scenarios;
}
function shapesFor(pair) { return (pair.defKind === "conc" || pair.altKind === "conc") ? SHAPES : ["n/a"]; }

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

// Virtual reserves at (sqrtP, L): r0 = L*2^96/s, r1 = L*s/2^96, the same mapping
// RouteLib._vr and measure-conc.test.js's V2-reduction check use.
function buildV2At(sqrtP, L, fee) {
    const r0 = (L * Q96) / sqrtP, r1 = (L * sqrtP) / Q96;
    return v2Model(r0 > 0n ? r0 : 1n, r1 > 0n ? r1 : 1n, fee.num, fee.den);
}

// Always at peg (b0 == b1): a stableswap barely moves off peg under balance imbalance
// (CurveLib.price prices off an A-aware get_dy quote, not the balance ratio), so it is
// always the grid's price ANCHOR when present, never the dislocated leg (see buildPair).
// `.real` is left null: legNormalize falls back to stableNormalizeModel (a pure-JS port of
// CurveLib.price and CurveLib.depth's tangent fit against this engine's own calibrated
// stableOut), since this sweep is fork-free and has no live/mock pool to read.
function buildStableAtPeg(L, fee) {
    return stableModel(L, L, 1000n, fee.num, fee.den); // A=1000, as calibrated in measure-stable.test.js
}

// Concentrated tick distributions, always centered on the model's OWN current tick: a
// real pool's liquidity distribution is inherent to itself, not relative to any other
// pool's price, so a "dislocated" leg's shape moves WITH it, not away from it.
function buildConcTicks(shape, centerTick, L, spacing) {
    const D = L, T = D / 10000n > 0n ? D / 10000n : 1n;
    if (shape === "uniform") {
        const w = 60000; // wider than any grid dislocation (max ~8200 raw ticks at 50%)
        return { ticks: [{ tick: centerTick - w, liqNet: D }, { tick: centerTick + w, liqNet: -D }], spotL: D };
    }
    if (shape === "mild-cliff" || shape === "sharp-cliff") {
        const core = shape === "mild-cliff" ? 100 : 10;
        const skirt = 2000;
        return {
            ticks: [
                { tick: centerTick - skirt, liqNet: T }, { tick: centerTick - core, liqNet: D },
                { tick: centerTick + core, liqNet: -D }, { tick: centerTick + skirt, liqNet: -T },
            ],
            spotL: D + T,
        };
    }
    if (shape === "thin-active") {
        // thin at the active tick, a deep neighbor one spacing step away on both sides:
        // V3Depth.sol's own motivating example ("a thin active tick beside a deep range").
        return { ticks: [{ tick: centerTick - spacing, liqNet: T - D }, { tick: centerTick + spacing, liqNet: D - T }], spotL: T };
    }
    throw new Error("unknown shape " + shape);
}
// spacing=1 (not the on-chain-typical 10/60): keeps "N ticks" in the shape names reading
// as raw ticks, and lets a dislocation snap to the exact nearest raw tick (tightest
// resolution at the smallest 0.05% bucket, where a coarser spacing would be a bigger
// fraction of the bump itself).
function buildConcAt(shape, tick, L, fee) {
    const spacing = 1;
    const { ticks, spotL } = buildConcTicks(shape, tick, L, spacing);
    return concModel(sqrtAtTick(tick), tick, spacing, ticks, fee.num, fee.den, spotL);
}

function buildLeg(kind, sqrtWanted, depth, shape, fee) {
    if (kind === "v2") return buildV2At(sqrtWanted, depth, fee);
    if (kind === "stable") return buildStableAtPeg(depth, fee);
    return buildConcAt(shape, tickAtSqrt(sqrtWanted), depth, fee);
}

// Build one grid point's (defended, alt). Rules: the STABLE leg, if present, is always
// the price anchor (dislocating a stableswap by balance imbalance alone barely moves its
// A-aware price, so it would not exercise the intended dislocation magnitude); otherwise
// the ALT anchors by convention and the DEFENDED dislocates. Depth: the DEFENDED is
// always the slice's reference depth (`baseL`, one of BASE_LS); the ALT is baseL scaled
// by the depth-ratio, matching the ratio's own definition (altL/defL). Whichever slot
// ends up driving (resolveDriver) always has the HIGHER price (the anchor bumped up), so
// `dir` always comes out true; computeDir below still derives it from the shipped meet
// rather than assuming it.
function buildPair(pair, depthRatio, dislocation, shape, fees, baseL) {
    const stableSlot = pair.defKind === "stable" ? "def" : pair.altKind === "stable" ? "alt" : null;
    const anchorSlot = stableSlot ?? "alt";
    const dislocSlot = anchorSlot === "def" ? "alt" : "def";

    const dislocSqrt = ANCHOR_SQRT + (ANCHOR_SQRT * dislocation.num) / dislocation.den;
    const defSqrt = dislocSlot === "def" ? dislocSqrt : ANCHOR_SQRT;
    const altSqrt = dislocSlot === "alt" ? dislocSqrt : ANCHOR_SQRT;

    const altDepth = (baseL * depthRatio.num) / depthRatio.den;

    const defended = buildLeg(pair.defKind, defSqrt, baseL, shape, fees.def);
    const alt = buildLeg(pair.altKind, altSqrt, altDepth, shape, fees.alt);
    return { defended, alt };
}

// Runs capture.js's own resolveDriver and MeetingPrice.meet once, purely to know which way
// to tell captureFraction to drive: captureFraction never derives `dir` itself, and every
// caller computes it the same way beforehand (see measure-v2/conc/stable.test.js).
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

const RATIO_SCALE = 10n ** 18n;

// Mechanism (A)'s worked example needs two things checked against this run's own numbers,
// not asserted: (1) the fee-implied "kick" (`sd*(gamma-1)`) vs the actual dislocation
// (`sd-sa`), computed rather than estimated, and (2) whether the interval clamp
// (MeetingPrice._clampIv) actually pins anything for the point the report shows, or is a
// no-op because the raw target already lands interior (the whole story of the points the
// clamp leaves). Re-derives MeetingPrice.meet's own raw intermediates (sd, sa, gamma) AND
// calls the shipped meetBoth for the actual (possibly clamped) finals, replaying the
// identical harness calls computeDir already makes for that point's own (pair, depthRatio,
// dislocation, shape, fees). The main grid stores only `dir` per point, so this is a
// one-off recomputation for whichever single point ends up illustrating mechanism (A).
// Stays BigInt throughout except the reported ratio (a reporting figure, not money math).
async function mechanismADetail(h, pair, depthRatio, dislocation, shape, fees, baseL) {
    const { defended, alt } = buildPair(pair, depthRatio, dislocation, shape, fees, baseL);
    const dn = await legNormalize(h, defended), an = await legNormalize(h, alt);
    const ld = dn.l ?? await concLegL(h, defended, an.s);
    const la = an.l ?? await concLegL(h, alt, dn.s);
    const [nd, dd] = feeND(defended), [na, da] = feeND(alt);
    const sd = dn.s, sa = an.s;
    // gamma = 1/sqrt((nd/dd)(na/da)) = sqrt((dd*da)/(nd*na)), MeetingPrice.meet's own G/P,
    // computed at RATIO_SCALE fixed-point precision (gamma is generally irrational, so it
    // has no exact BigInt form).
    const gammaScaled = isqrt((dd * da * RATIO_SCALE * RATIO_SCALE) / (nd * na));
    const kick = (sd * (gammaScaled - RATIO_SCALE)) / RATIO_SCALE; // sd*(gamma-1)
    const dislocationMag = sd > sa ? sd - sa : sa - sd;
    const ratio = dislocationMag === 0n ? null : Number((kick * 10000n) / dislocationMag) / 10000;
    const [sdFinal, saFinal] = await h.mp.meetBoth(sd, ld, nd, dd, sa, la, na, da);
    const lo = sd < sa ? sd : sa, hi = sd < sa ? sa : sd;
    const interior = sdFinal !== lo && sdFinal !== hi && saFinal !== lo && saFinal !== hi;
    return { ratio, sd, sa, lo, hi, sdFinal, saFinal, interior };
}

// ---------------------------------------------------------------------------
// Route sub-grid (reduced; the report's Route sub-grid section says why)
// ---------------------------------------------------------------------------

async function buildHopPool(conn, me, kind, nearTok, farTok) {
    const nearAddr = (await nearTok.getAddress()).toLowerCase();
    const farAddr = (await farTok.getAddress()).toLowerCase();
    const [loTok, hiTok] = nearAddr < farAddr ? [nearTok, farTok] : [farTok, nearTok];
    const dirNearToFar = nearAddr < farAddr; // near is token0 -> spend near for far is zeroForOne=true

    if (kind === "v2") {
        const RESV = 500000n * ONE; // deep, ~1:1
        const feeNum = 9975n, feeDen = 10000n;
        const pool = await deploy(conn, "MockV2Pool", null, [await loTok.getAddress(), await hiTok.getAddress(), feeNum, feeDen]);
        await loTok.mint(me.address, RESV);
        await hiTok.mint(me.address, RESV);
        await loTok.approve(await pool.getAddress(), RESV);
        await hiTok.approve(await pool.getAddress(), RESV);
        await pool.initReserves(RESV, RESV);
        const model = v2Model(RESV, RESV, feeNum, feeDen);
        return { pool, kind: 0, fee: feeDen - feeNum, model, dir: dirNearToFar };
    }
    // conc: uniform shape, deep, ~1:1 (tick 0)
    const feeNum = 999500n, feeDen = 1000000n;
    const L = 10n ** 24n;
    const { ticks, spotL } = buildConcTicks("uniform", 0, L, 1);
    const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spotL, 1, await loTok.getAddress(), await hiTok.getAddress()]);
    for (const t of ticks) await pool.setTick(t.tick, t.liqNet);
    const model = concModel(Q96, 0, 1, ticks, feeNum, feeDen, spotL);
    return { pool, kind: 2, fee: feeDen - feeNum, model, dir: dirNearToFar };
}

// Registers a real 2-hop route (T0 -> MID -> T1) in a fresh registry, as route-v2.test.js's
// setup() does: the ONLY way to get RouteLibHarness.normalize / effectiveLiquidity to read
// something (they read live pool state through the registry, never a JS model). Returns the
// route handle plus each hop's own engine model + drive direction, for the engine's route
// profit (see routeProfit in capture.js).
async function setupRoute(conn, me, hop1Kind, hop2Kind) {
    const mkToken = async (sym) => deploy(conn, "MockERC20", null, ["Mock " + sym, sym]);
    const T0 = await mkToken("T0"), MID = await mkToken("MID"), T1 = await mkToken("T1");
    const t0Addr = (await T0.getAddress()).toLowerCase(), t1Addr = (await T1.getAddress()).toLowerCase();
    const [t0Tok, t1Tok] = t0Addr < t1Addr ? [T0, T1] : [T1, T0];

    const hop1 = await buildHopPool(conn, me, hop1Kind, t0Tok, MID);
    const hop2 = await buildHopPool(conn, me, hop2Kind, MID, t1Tok);

    const registry = await deploy(conn, "PoolRegistryHarness");
    const h1Id = idAddr(await hop1.pool.getAddress()), h2Id = idAddr(await hop2.pool.getAddress());
    const routeId = idRoute(h1Id, h2Id);
    await registry.setPools(await t0Tok.getAddress(), await MID.getAddress(), [[h1Id, hop1.kind, hop1.fee, 0]]);
    await registry.setPools(await MID.getAddress(), await t1Tok.getAddress(), [[h2Id, hop2.kind, hop2.fee, 0]]);
    await registry.setPools(await T0.getAddress(), await T1.getAddress(), [[routeId, ROUTE, 0, 0]]);
    await registry.setConfig(routeId, configRoute(h1Id, h2Id, await MID.getAddress()));

    return {
        reg: await registry.getAddress(), routeId,
        hop1Model: hop1.model, hop2Model: hop2.model, dir1: hop1.dir, dir2: hop2.dir,
    };
}

async function routePoint(h, defKind, hopCombo, dislocation, label) {
    const dislocSqrt = ANCHOR_SQRT + (ANCHOR_SQRT * dislocation.num) / dislocation.den;
    const fee = defKind === "v2" ? V2_FEES[0] : CONC_FEES[0];
    const defended = buildLeg(defKind, dislocSqrt, ROUTE_BASE_L, "uniform", fee);

    const dn = await legNormalize(h, defended);
    const an = await routeNormalize(h, hopCombo);
    const ld = dn.l ?? await concLegL(h, defended, an.s);
    const la = await routeLegL(h, hopCombo, dn.s);
    const [nd, dd] = feeND(defended);
    const [sdF] = await h.mp.meetBoth(dn.s, ld, nd, dd, an.s, la, an.fn, an.fd);
    const dir = dn.s > sdF;

    const r = await captureFractionRoute(h, defended, hopCombo, hopCombo.hop1Model, hopCombo.hop2Model, dir, hopCombo.dir1, hopCombo.dir2);
    return { hopShapes: label, defKind, dislocation: dislocation.label, dir, ...r };
}

// ---------------------------------------------------------------------------
// Aggregation + report
// ---------------------------------------------------------------------------

function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function fmtPct(x) { return (x * 100).toFixed(2) + "%"; }

// Region key includes the absolute-depth slice (L=): a degradation that only exists at
// one absolute scale must surface as its own region, not be averaged into the other
// slices' numbers.
function regionOf(p) { return `${p.pair} | shape=${p.shape} | dislocation=${p.dislocation} | L=${p.baseL}`; }

function aggregateRegions(points) {
    const map = new Map();
    for (const p of points) {
        const key = regionOf(p);
        if (!map.has(key)) map.set(key, { key, pair: p.pair, shape: p.shape, dislocation: p.dislocation, baseL: p.baseL, points: [] });
        map.get(key).points.push(p);
    }
    for (const region of map.values()) {
        const captures = region.points.map((p) => p.capture);
        region.median = median(captures);
        region.worst = Math.min(...captures);
        region.worstPoint = region.points.find((p) => p.capture === region.worst);
    }
    return [...map.values()];
}

// Classifies every overshoot by `optimalProfit` SIGN, not dislocation size (a split by
// dislocation size mis-attributes the overshoots and misses a mechanism; see WHY THE
// OVERSHOOTS HAPPEN in buildReport below for the full writeup):
//
// - `optimalProfit <= 0`: NO profitable arb exists in either direction. VanHelsing's
//   effective no-op is economically correct; the only defect is attempting (paying gas
//   for) a provably-losing drive instead of detecting NO_ARB. Mechanism (A).
// - `optimalProfit > 0`: a genuinely exploitable dislocation goes undefended. Split by
//   whether a stable leg is present: a stable leg is NEVER the driver (VanHelsing cannot
//   flash it, so resolveDriver always makes it the sink), so the stable bucket is labeled
//   mechanism (C) (the sink's depth over-stated) and the rest mechanism (B) (a concentrated
//   leg's walked range misread). CAVEAT, measured 2026-07-08: this pair-based split is a
//   PROXY, not a mechanism proof. The stableswap capacity cap closed the true stable-sink
//   saturation, and a substitution experiment then attributed the stable bucket's
//   above-floor residue to the conc DRIVER's walked-depth misread (mechanism (B)'s cause
//   on a stable pair). The two-pass sizing fixes that driver-side cause with the
//   DIRECTIONAL combine (driver keeps max(pass1, pass2), sink keeps min): the (C) bucket's
//   above-floor residue drops 54 -> 9, and mechanism (B)'s own above-floor total drops
//   252 -> 141 (its <=10%-dislocation slice, the actionable band, 135 -> 33). The last 9 of
//   (C) went once the model met the driving pool first, as VanHelsing._finals does (it had
//   met the defended stableswap first): measured 2026-10-27, (C) has no above-floor
//   residue. What remains is (B)'s: its 33 are a concentrated-SINK capacity ceiling
//   (VanHelsing has no capacity cap for concentrated sinks), and its 108 a one-damped-step
//   50%-dislocation linearization tail (accepted as a documented limit). A full-range capacity-weighted MEAN walk was
//   measured before the two-pass sizing and REJECTED (it regressed two real-pool fork
//   gates). The lists below keep the pair-based bucketing (every count and guard reads
//   it); each guard pins its residue's profile + exact count, and the report's mechanism
//   (B)/(C) sections narrate the split.
function classifyOvershoots(points) {
    const overshoots = points.filter((p) => p.overshoot);
    const noArbAttempted = overshoots.filter((p) => p.optimalProfit <= 0n);
    // Mechanism (A)'s "no arb in EITHER direction" is MEASURED: captureFraction golden-
    // searches the reverse drive for every optimalProfit <= 0 point and records its
    // optimum in optimalProfitReverse (never null for these points, by construction). A
    // point whose reverse optimum is positive is NOT gas-only mechanism (A): it means a
    // real arb existed and the sizer drove the wrong way past it, so it is split out and
    // surfaced separately in the report instead of being absorbed into (A).
    const noArbBothDirs = noArbAttempted.filter((p) => p.optimalProfitReverse !== null && p.optimalProfitReverse <= 0n);
    const reversePositive = noArbAttempted.filter((p) => p.optimalProfitReverse !== null && p.optimalProfitReverse > 0n);
    // A positive reverse optimum below the precision floor is the same rounding dust the
    // floor exists for (see isDust above), just on the reverse profit curve; one above
    // the floor would be a genuine drove-the-wrong-way finding and the report flags it.
    const reversePositiveDust = reversePositive.filter((p) => p.optimalProfitReverse < baseLOf(p.baseL) / DUST_DIV);
    // Same floor bookkeeping mechanisms (B)/(C) get, applied to (A); see isDustA's own
    // comment for why the comparison is against chosenProfit, not optimalProfit, here.
    const noArbAttemptedDust = noArbAttempted.filter(isDustA);
    const realArbLost = overshoots.filter((p) => p.optimalProfit > 0n);
    const realArbLostStable = realArbLost.filter((p) => p.pair.includes("stable")); // (C)
    const realArbLostCliff = realArbLost.filter((p) => !p.pair.includes("stable")); // (B)
    const realArbLostStableDust = realArbLostStable.filter(isDust);
    const realArbLostCliffDust = realArbLostCliff.filter(isDust);
    const bestOf = (list) => list.reduce((best, p) => (!best || p.optimalProfit > best.optimalProfit ? p : best), null);
    return {
        overshoots, noArbAttempted, noArbBothDirs, reversePositive, reversePositiveDust, noArbAttemptedDust,
        realArbLost, realArbLostStable, realArbLostCliff, realArbLostStableDust, realArbLostCliffDust,
        exampleA: noArbAttempted[0] ?? null,
        exampleB: bestOf(realArbLostCliff),
        exampleC: bestOf(realArbLostStable),
    };
}

function buildReport({ points, regions, routePoints, routeReduced, exampleADetail }) {
    // Mechanism (C)'s "orders of magnitude" figure, recomputed LIVE on every run from the
    // exact 3:4-imbalanced construction the stableNormalizeModel sanity test below gates
    // (committed floor: l > 100x the constant-product fallback), so the printed multiple
    // is always this run's own measurement, never a stale hardcoded number.
    const imbB0 = 300_000n * ONE, imbB1 = 400_000n * ONE;
    const cpMultiple = Number(stableNormalizeModel(stableModel(imbB0, imbB1, 1000n, 9996000000n, 10000000000n)).l * 100n / isqrt(imbB0 * imbB1)) / 100;

    const captures = points.map((p) => p.capture);
    const overallMedian = median(captures);
    const overallWorst = Math.min(...captures);
    const overallWorstPoint = points.find((p) => p.capture === overallWorst);
    const degraded = regions.filter((r) => r.worst < 0.90).sort((a, b) => a.worst - b.worst);
    const cls = classifyOvershoots(points);
    const {
        overshoots, noArbAttempted, noArbBothDirs, reversePositive, reversePositiveDust, noArbAttemptedDust,
        realArbLost, realArbLostCliff, realArbLostStable, realArbLostCliffDust, realArbLostStableDust,
    } = cls;
    const routeOvershoots = routePoints.filter((p) => p.overshoot);
    // Not gated on .overshoot: a dust-scale optimalProfit makes ANY chosen profit that
    // doesn't fully match it read as ~0% capture, whether the chosen size is a real loss
    // (overshoot) or a correctly-sized zero drive against an unreachable dust target (a
    // sub-fee point the fee check or the interval clamp leaves undriven): both divide by
    // the same meaningless denominator. Matches the per-region tagging below (isDust(wp)
    // alone).
    const degradedDustWorst = degraded.filter((r) => isDust(r.worstPoint));

    // The (C) bucket's above-floor residue, recomputed LIVE every run: the same above-floor
    // test the sweep's own guard pins (see the "guard" it below). When it is not 0, the WHY
    // THE OVERSHOOTS HAPPEN section below needs the live shape of the survivors (leg-ratio
    // extremity, dislocation) to describe them from this run's own data.
    const cAboveFloor = realArbLostStable.length - realArbLostStableDust.length;
    const extremeRatioLabels = [DEPTH_RATIOS[0].label, DEPTH_RATIOS[DEPTH_RATIOS.length - 1].label];
    const cAboveFloorPts = realArbLostStable.filter((p) => !realArbLostStableDust.includes(p));
    const cAboveFloorExtreme = cAboveFloorPts.filter((p) => extremeRatioLabels.includes(p.depthRatio)).length;
    const cAboveFloorMatchedRatio = cAboveFloorPts.filter((p) => p.depthRatio === "1").length;

    const lines = [];
    lines.push("# Van Helsing Capture-Quality Measurement");
    lines.push("");
    lines.push("Generated by `test/measure-sweep.test.js`, part of the capture-measurement suite.");
    lines.push("Fork-free: every leg is a mock pool or a pure-BigInt model, sized through the shipped");
    lines.push("`MeetingPriceHarness` + `V3DepthHarness` + `RouteLibHarness`, the same code VanHelsing");
    lines.push("itself calls.");
    lines.push("");

    lines.push("## READING");
    lines.push("");
    lines.push("`capture = profit(VanHelsing's chosen drive size) / profit(the true optimal size)`,");
    lines.push("computed by a golden-section search over the same pool-model engine. 100% means");
    lines.push("VanHelsing's shipped sizer (MeetingPrice + the bounded depth walk) drives exactly");
    lines.push("the arb-maximizing amount; below 100% it leaves money on the table (funds-safe,");
    lines.push("under-drives); an `overshoot` means the chosen size, if actually executed, would");
    lines.push("realize a NEGATIVE profit (capture clamped to 0 in that case, since a negative");
    lines.push("chosen profit divided by a positive optimal is not a meaningful fraction). When the");
    lines.push("true optimal itself is <= 0 (no profitable size exists in the driven direction; the");
    lines.push("REVERSE direction is then also golden-searched, and mechanism (A) below reports the");
    lines.push("measured both-directions result), capture reads 100% by convention even when");
    lines.push("`overshoot` is also true: there is nothing to have captured, but the attempt still");
    lines.push("paid gas on a provably-losing drive (mechanism (A) below). This is why that mechanism");
    lines.push("never shows up as a degraded region or a worst-capture number, only in the overshoot");
    lines.push("counts. The <=100% clamp polices itself: a chosen profit exceeding the searched");
    lines.push("optimum by more than a few wei would mean the golden search under-found the max and");
    lines.push("every number here is inflated, so `capture.js` flags it (`optimizerUnderFound`) and");
    lines.push("this suite's guard asserts the flag never fires.");
    lines.push("\"Degraded\" means capture < 90%; regions are grouped by (model pair, concentrated");
    lines.push("depth shape, dislocation, absolute depth BASE_L).");
    lines.push("");
    lines.push("An overshoot is NOT a realized fund loss: VanHelsing is fundless and every flash");
    lines.push("drive self-repays or the whole `execute()` frame reverts and rolls back (see");
    lines.push("`VanHelsing.sol`'s own header comment, invariant 1); `ward()` then swallows that");
    lines.push("revert (invariant 2), so an overshoot means the ward's drive fails harmlessly, not");
    lines.push("that money moves at a loss. It still matters: a reverted attempt is wasted gas, and");
    lines.push("in the two more serious mechanisms below (B and C), it means a genuinely exploitable");
    lines.push("dislocation goes undefended for that attempt. See \"WHY THE OVERSHOOTS HAPPEN\" below.");
    lines.push("");

    lines.push("## CALIBRATION");
    lines.push("");
    lines.push("This sweep is a pure measurement exercise built on an engine calibrated by");
    lines.push("`test/measure-v2.test.js`, `test/measure-conc.test.js` and `test/measure-stable.test.js`");
    lines.push("(the committed calibration runs, all passing alongside this sweep). This");
    lines.push("report is regenerated verbatim on every run, so every bound quoted below is the gate");
    lines.push("those files actually ASSERT; anything tighter is quoted only as a logged observation");
    lines.push("from a dated run, never as the gate:");
    lines.push("");
    lines.push("- V2: the engine's `v2Out` matches `V2Lib.amountOut`'s closed form (exact-value unit");
    lines.push("  test); a real `MockV2Pool` ward self-calibration gates the engine's predicted profit");
    lines.push("  to within 100 wei of the beneficiary's realized gain (asserted `<= 100` wei;");
    lines.push("  observed delta 0 wei on 2026-07-08).");
    lines.push("- Concentrated (represents V3/V4/Infinity): two committed unit gates pin the tick");
    lines.push("  engine's internal consistency: a single constant-L range reproduces the V2 closed");
    lines.push("  form within 1e-6 relative error, and `v3SwapToTarget`'s chosen input round-trips");
    lines.push("  through `v3Out` to the same output within 1e-9. Fork calibration against real BSC");
    lines.push("  V3 and V4 wards gates the engine's profit to within 1% relative error of the");
    lines.push("  realized gain (`relErr <= 0.01`; the relErr metric's own resolution is 1e-6, so");
    lines.push("  nothing tighter than 1e-6 is even measurable through it), and the V4 gate");
    lines.push("  additionally asserts the drive provably crosses at least 2 real initialized ticks");
    lines.push("  (`minCrossed >= 2`). Observed on 2026-07-08: the V4 drive crossed 37 real ticks and");
    lines.push("  its engine-vs-realized delta was 17596 wei on a ~1.5e22-wei profit (relErr reads 0");
    lines.push("  at the metric's 1e-6 resolution).");
    lines.push("- Stableswap: the Curve `get_y` engine is gated wei-exact (asserted `equal`) against a");
    lines.push("  real PancakeStableSwap pool's `get_dy` across four trade sizes and both directions;");
    lines.push("  end-to-end fork calibration (front-run + ward) gates the engine's profit to within");
    lines.push("  1% relative error of the realized gain, and the committed capture assertion there is");
    lines.push("  a floor of 0.82, not just `within(0, 1)` (observed on 2026-07-08: engine vs realized");
    lines.push("  differed by 2 wei on a ~7.4e19-wei profit, capture read ~82.4%). That ~82.4% NEAR");
    lines.push("  PEG, IN RANGE is `CurveLib.depth`'s tangent under-stating the amplified near-peg");
    lines.push("  depth: a known, accepted under-size (funds-safe). On the OTHER side of the tangent");
    lines.push("  (mechanism (C)'s saturation over-statement), a directional-secant depth in place of");
    lines.push("  the tangent was implemented, measured, and REJECTED on this same fork scenario");
    lines.push("  (capture 82.4% -> 71.4%, below the bar, while still leaving 264 above-floor (C)");
    lines.push("  survivors in this sweep). The shipped design keeps the tangent and bounds it instead");
    lines.push("  with a hard capacity cap over the restore's price interval (at the end of");
    lines.push("  `CurveLib.depth`; see mechanism (C) below). The cap does not bind on this imbalanced");
    lines.push("  fork pool (tangent ~200x balances vs a ~3.8x-larger cap; a unit test also pins a");
    lines.push("  synthetic near-peg non-binding case), and the fork run with the cap reproduces the");
    lines.push("  uncapped sizing bit-for-bit (capture 82.37%, engine-vs-realized 2 wei), so the");
    lines.push("  near-peg behavior is preserved by construction, not by luck.");
    lines.push("");
    lines.push("This sweep is fork-free, so a synthetic stable leg has no live pool for `CurveLib` to");
    lines.push("read. It instead goes through `stableNormalizeModel` (in `pool-model.js`), a");
    lines.push("line-by-line JS port of `CurveLib.price` and the tangent fit in `CurveLib.depth` (a");
    lines.push("balance-scaled unit quote, min(1e18, b0/1000), for price, and a `b0/100` reference");
    lines.push("trade for the near-peg tangent depth fit), evaluated against this engine's own");
    lines.push("`stableOut`, the same routine `test/measure-stable.test.js` calibrates wei-exact against");
    lines.push("the live pool above. The capacity cap is reproduced in ONE place, `capture.js`'s");
    lines.push("`vanHelsingDriveSize` (`capStableL`), at the step where VanHelsing applies it (pass 1");
    lines.push("of `_meet`, inside `CurveLib.depth`), so every sized point in this sweep flows through");
    lines.push("it. The port is cross-checked in this file's own \"stableNormalizeModel\" test against an");
    lines.push("independently-written transcription of the same formulas, and reproduces both the");
    lines.push("A-aware near-peg pricing and the amplified (not constant-product) depth on an");
    lines.push("imbalanced pool. See that test and `pool-model.js` for detail.");
    lines.push("");

    lines.push("## HEADLINE");
    lines.push("");
    lines.push(`- Main grid: ${points.length} points.`);
    lines.push(`- Overall median capture: **${fmtPct(overallMedian)}**.`);
    lines.push(`- Overall worst capture: **${fmtPct(overallWorst)}** (${regionOf(overallWorstPoint)}, depthRatio=${overallWorstPoint.depthRatio}, fee=${overallWorstPoint.fee}).`);
    lines.push(`- Degraded regions (capture < 90%): **${degraded.length}** of ${regions.length}${degradedDustWorst.length === 0 ? "" : ` (${degradedDustWorst.length} of them on a below-precision-floor worst point: a rounding-dust denominator, see Absolute-depth slices)`}.`);
    lines.push(`- Overshoots (chosen size loses money): **${overshoots.length}** in the main grid, **${routeOvershoots.length}** in the route sub-grid.`);
    const revNote = reversePositive.length === 0 ? ""
        : reversePositiveDust.length === reversePositive.length
            ? `, ${reversePositive.length} read a positive reverse optimum, all below the precision floor (rounding dust)`
            : `, ${reversePositive.length} read a positive reverse optimum of which ${reversePositive.length - reversePositiveDust.length} are ABOVE the precision floor (REAL; see mechanism (A))`;
    lines.push(`  - **${noArbAttempted.length}** no-arb-attempted, gas-only, mechanism (A) (\`optimalProfit <= 0\` in the driven`);
    lines.push(`    direction; the REVERSE direction was also golden-searched: ${noArbBothDirs.length} of ${noArbAttempted.length} measured no-arb`);
    lines.push(`    BOTH ways${revNote}).`);
    const cReclassNote = cAboveFloor === 0 ? "" : `, of which the ${cAboveFloor} above-floor are the stable-sink 50% linearization tail (see mechanism (C))`;
    lines.push(`  - **${realArbLost.length}** real-arb-lost (\`optimalProfit > 0\`: a genuine dislocation went undefended): **${realArbLostCliff.length}** conc-cliff depth-walk over-sizing (B)${realArbLostCliffDust.length === 0 ? "" : ` (${realArbLostCliffDust.length} below the precision floor)`}, **${realArbLostStable.length}** in the stable-pair bucket (C)${realArbLostStableDust.length === 0 ? "" : ` (${realArbLostStableDust.length} below the precision floor)`}${cReclassNote}.`);
    lines.push("  See \"WHY THE OVERSHOOTS HAPPEN\" for the full mechanism writeup.");
    lines.push("");

    lines.push("## Absolute-depth slices");
    lines.push("");
    lines.push("The absolute-depth axis (BASE_L = the defended leg's depth; the alt leg is BASE_L");
    lines.push("scaled by the depth ratio) runs the same relative grid at " + BASE_LS.map((b) => b.label).join(", ") + ",");
    lines.push("separating scale-dependent effects (wei rounding, fixed-point resolution, the shipped");
    lines.push("code's own absolute-size constants) from scale-free capture behavior. Overshoot split");
    lines.push("is mechanism (A)/(B)/(C); \"below floor\" counts the (B)/(C) overshoots whose positive");
    lines.push("optimum is under the precision floor (optimalProfit < BASE_L/1e12; see below).");
    lines.push("");
    lines.push("| BASE_L | points | median capture | worst capture | overshoots (A/B/C) | below floor | degraded regions |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const b of BASE_LS) {
        const slice = points.filter((p) => p.baseL === b.label);
        const sc = slice.map((p) => p.capture);
        const so = slice.filter((p) => p.overshoot);
        const sA = so.filter((p) => p.optimalProfit <= 0n).length;
        const sB = so.filter((p) => p.optimalProfit > 0n && !p.pair.includes("stable")).length;
        const sC = so.filter((p) => p.optimalProfit > 0n && p.pair.includes("stable")).length;
        const sDust = so.filter(isDust).length;
        const sliceRegions = regions.filter((r) => r.baseL === b.label);
        const sliceDegraded = sliceRegions.filter((r) => r.worst < 0.90).length;
        lines.push(`| ${b.label} | ${slice.length} | ${fmtPct(median(sc))} | ${fmtPct(Math.min(...sc))} | ${so.length} (${sA}/${sB}/${sC}) | ${sDust} | ${sliceDegraded} of ${sliceRegions.length} |`);
    }
    lines.push("");

    // Live evidence for the two scale effects the axis surfaced, recomputed every run:
    // (1) the dust-vs-genuine optimum gap that justifies the precision floor, and (2) the
    // tiny stable pools where a FIXED 1e18 price probe used to break down, read through the
    // balance-scaled quote (at the same A=1000, zero fee for the cleanest read of the probe
    // effect).
    const dustPts = overshoots.filter(isDust);
    const maxDust = dustPts.reduce((m, p) => (p.optimalProfit > m ? p.optimalProfit : m), 0n);
    // 36 digits of fixed-point headroom: a dust optimum can be ~1e-26 of its slice's
    // depth, far below what 18 digits would resolve (at a 1e18 scale it prints as 0).
    const relOf = (p) => Number((p.optimalProfit * 10n ** 36n) / baseLOf(p.baseL)) / 1e36;
    const maxDustRel = dustPts.length ? Math.max(...dustPts.map(relOf)) : 0;
    const genuinePos = points.filter((p) => p.optimalProfit > 0n && !isDust(p));
    const minGenuineRel = genuinePos.length ? Math.min(...genuinePos.map(relOf)) : 0;
    const probeDemo = (b) => stableNormalizeModel(stableModel(b, b, 1000n, 10000000000n, 10000000000n));
    const p17 = probeDemo(10n ** 17n), p20 = probeDemo(10n ** 20n), p21 = probeDemo(10n ** 21n);
    const s17 = (Number((p17.s * 10n ** 6n) / Q96) / 1e6).toFixed(3);
    const l20x = Number(p20.l / 10n ** 20n).toExponential(1);
    const l21x = Number((p21.l * 10n) / 10n ** 21n) / 10;

    lines.push("What the axis surfaced, and how each item classifies:");
    lines.push("");
    lines.push("**Huge depth (1e28): a MEASUREMENT-PRECISION effect on the classifier's threshold,");
    lines.push("not a Van Helsing defect.** The engine's per-swap integer rounding leaves a wei-scale");
    lines.push("sawtooth on the profit curve whose absolute size grows with depth; at 1e28 it is tens");
    lines.push("of wei. Grid points whose exact optimum is ~0 (mechanism (A)'s fee-kick geometry:");
    lines.push("small dislocations swamped by fees) can therefore read a positive optimum of pure");
    lines.push(`rounding dust and cross into the (B)/(C) counts. This run: ${dustPts.length} such points, largest`);
    lines.push(`dust optimum ${maxDust} wei (${maxDustRel.toExponential(1)} of its slice's depth), while the smallest GENUINE`);
    lines.push(`optimum anywhere in the grid is ${minGenuineRel.toExponential(1)} of depth. The 1e-12 floor sits in the`);
    lines.push("middle of that gap, orders of magnitude clear of both sides. Below-floor points stay");
    lines.push("in every count and list, tagged, rather than being silently reclassified; the same");
    lines.push("floor applies to the handful of (A) points whose REVERSE-direction optimum reads");
    lines.push("dust-positive (see mechanism (A)). The extra degraded regions the 1e28 slice shows");
    lines.push("are the same artifact: a 0%-capture worst point whose denominator is a dust optimum.");
    lines.push("");
    lines.push("**Tiny depth (1e20): a REAL scale-dependence in the stableswap price's old FIXED");
    lines.push("probe size on very small stable pools, now FIXED by a balance-scaled quote.**");
    lines.push("`CurveLib` used to price off a FIXED 1e18-wei unit quote; that absolute size stopped");
    lines.push("being marginal when the pool itself was small. Three broken regimes were measured on");
    lines.push("a 2026-07-08 run with the fixed quote: b0 <= ~1e19 read a phantom price (0.316x peg");
    lines.push("at b0 = 1e17, a ~68% dislocation invented on a pool sitting exactly at peg) with a");
    lines.push("constant-product depth fallback; b0 ~= 1e20 had the 1e18 quote COINCIDE with the");
    lines.push("b0/100 depth reference, collapsing the fit's denominator to rounding noise (reported");
    lines.push("depth ~8e26x the balances); only b0 >= ~1e21 was healthy. `CurveLib.price` now scales");
    lines.push("the unit quote to the pool (min(1e18, b0/1000), refusing unquotable dust with");
    lines.push("POOL_DUST), so the quote stays marginal and always distinct from the b0/100 reference.");
    lines.push("Measured live on this run's own models (balanced pool, A=1000, zero fee):");
    lines.push(`- b0 = 1e17 now prices at ${s17}x peg (was 0.316x) with a real tangent depth;`);
    lines.push(`- b0 = 1e20 (the old collision point) now reads ~${l20x}x the balances (was ~8e26x);`);
    lines.push(`- b0 = 1e21 reads ~${l21x.toFixed(0)}x: the same honest amplified regime at every scale.`);
    const tinyStableRegions = regions.filter((r) => isTinyStableProbe(r.worstPoint));
    const tinyStableDegraded = tinyStableRegions.filter((r) => r.worst < 0.90);
    lines.push(`This run: ${tinyStableRegions.length} regions' worst points sit on a stable leg with <= 1e20-wei balances`);
    lines.push(`(${tinyStableDegraded.length} of them degraded). Under the old fixed probe these were the tiny-stable-pool`);
    lines.push("breakdown cluster (over-drives on the collision side, deep funds-safe under-drives on");
    lines.push("the fallback side); with the balance-scaled quote, a degraded region left here must");
    lines.push("trace to an ordinary mechanism (see WHY THE OVERSHOOTS HAPPEN), not to probe scaling.");
    lines.push("");

    lines.push("## Summary by region");
    lines.push("");
    lines.push("Sorted worst-first. `n` = points aggregated (depth-ratio x fee scenario).");
    lines.push("");
    lines.push("| Region | n | median capture | worst capture |");
    lines.push("|---|---|---|---|");
    for (const r of [...regions].sort((a, b) => a.worst - b.worst)) {
        lines.push(`| ${r.key} | ${r.points.length} | ${fmtPct(r.median)} | ${fmtPct(r.worst)} |`);
    }
    lines.push("");

    lines.push("## DEGRADED REGIONS (capture < 90%)");
    lines.push("");
    if (degraded.length === 0) {
        lines.push("None: every region's worst point still cleared 90% capture.");
    } else {
        for (const r of degraded) {
            const wp = r.worstPoint;
            lines.push(`### ${r.key}`);
            lines.push("");
            lines.push(`- median capture: ${fmtPct(r.median)}, worst: ${fmtPct(r.worst)} (${r.points.length} points)`);
            lines.push(`- worst point: depthRatio=${wp.depthRatio}, fee=${wp.fee}, dir=${wp.dir}`);
            lines.push(`  - chosenProfit=${wp.chosenProfit}, optimalProfit=${wp.optimalProfit}, chosenSize=${wp.chosen}, optimalSize=${wp.optimalSize}`);
            lines.push(`  - overshoot=${wp.overshoot}`);
            if (isDust(wp)) {
                lines.push("  - the worst point's optimum is BELOW THE PRECISION FLOOR (< BASE_L/1e12): this");
                lines.push("    region's 0% is a rounding-dust denominator, not a material loss (see");
                lines.push("    Absolute-depth slices).");
            }
            if (wp.capBound && !wp.overshoot) {
                lines.push("  - the worst point's stable leg has the capacity cap BINDING and the chosen");
                lines.push("    drive did not overshoot: a documented, funds-safe under-drive, the cap's");
                lines.push("    designed trade at ratio-extreme/large-dislocation points (see mechanism");
                lines.push("    (C)).");
            }
            if (isTinyStableProbe(wp)) {
                lines.push("  - materiality note: the worst point's stable leg holds <= 1e20-wei balances");
                lines.push("    (0.1..100 tokens, a dust pool; the exploitable value is bounded by those");
                lines.push("    balances).");
            }
            lines.push("");
        }
    }
    lines.push("");

    // Classified by classifyOvershoots (optimalProfit SIGN, then stable-leg presence; see
    // its own header comment), NOT by dislocation size: a dislocation-size split
    // mis-attributes the overshoots and misses a mechanism entirely (a stable-sink
    // over-sizing failure, distinct from a concentrated leg's cliff running dry, even though
    // both land in the same "large dislocation" bucket). Dislocation is still shown per
    // mechanism below, but purely as descriptive color (via dislocBreakdown), not as the
    // classifier.
    const { exampleA, exampleB, exampleC } = cls; // realArbLostCliff/Stable already destructured above
    const pairsIn = (list) => [...new Set(list.map((p) => p.pair))].sort().join(", ") || "none";
    // Same list, but with a per-pair COUNT, in PAIRS' own declared order, for narrating a
    // live pair-type breakdown (e.g. "60 conc/stable, 57 stable/conc") instead of a
    // hardcoded one.
    const pairCounts = (list) => PAIRS.map((pp) => ({ label: pp.label, n: list.filter((p) => p.pair === pp.label).length }))
        .filter((x) => x.n > 0).map((x) => `${x.n} ${x.label}`).join(", ") || "none";
    const dislocBreakdown = (list) => {
        const counts = new Map();
        for (const p of list) counts.set(p.dislocation, (counts.get(p.dislocation) ?? 0) + 1);
        return DISLOCATIONS.map((d) => `${d.label}=${counts.get(d.label) ?? 0}`).join(", ");
    };

    lines.push("## WHY THE OVERSHOOTS HAPPEN");
    lines.push("");
    lines.push(`${overshoots.length} of ${points.length} main-grid points (${((overshoots.length * 100) / points.length).toFixed(1)}%) are overshoots. Classifying by`);
    lines.push("`optimalProfit`'s SIGN (whether a real arb existed at all), not dislocation-bucket size");
    lines.push("(which mis-attributes the split and misses a mechanism), turns up THREE distinct");
    lines.push("mechanisms, all real: none is an artifact of this test's construction, and all were");
    lines.push("traced by hand against `VanHelsing.sol` / `MeetingPrice.sol` / `CurveLib.sol` directly,");
    lines.push("not just this engine:");
    lines.push("");
    lines.push(`**(A) No-arb-attempted: \`optimalProfit <= 0\` (${noArbAttempted.length} of ${overshoots.length} overshoots; by dislocation: ${dislocBreakdown(noArbAttempted)}; precision floor: ${noArbAttempted.length - noArbAttemptedDust.length} above, ${noArbAttemptedDust.length} below).**`);
    if (reversePositive.length === 0) {
        lines.push(`There is NO profitable arb in EITHER direction, and \"either\" is MEASURED, not derived:`);
        lines.push(`for every one of these ${noArbAttempted.length} points the engine also golden-searched the REVERSE`);
        lines.push("drive direction, and every reverse optimum came back <= 0 as well. So VanHelsing's");
        lines.push("effective no-op is");
    } else if (reversePositiveDust.length === reversePositive.length) {
        lines.push("The engine golden-searched the REVERSE drive direction for every one of these points:");
        lines.push(`${noArbBothDirs.length} of ${noArbAttempted.length} measured no profitable arb in EITHER direction; the other ${reversePositive.length} read a`);
        lines.push("positive reverse optimum, every one of them below the precision floor (integer-rounding");
        lines.push("dust at the huge-depth slice; magnitudes listed at the end of this section, and see");
        lines.push("Absolute-depth slices), so no materially profitable reverse arb was missed. For all of");
        lines.push("these points, VanHelsing's effective no-op is");
    } else {
        lines.push("The engine golden-searched the REVERSE drive direction for every one of these points:");
        lines.push(`${noArbBothDirs.length} of ${noArbAttempted.length} measured no profitable arb in EITHER direction, but ${reversePositive.length - reversePositiveDust.length} read a`);
        lines.push("reverse optimum ABOVE the precision floor, a REAL finding: a material arb existed and");
        lines.push("the sizer drove the wrong way past it (listed at the end of this section as their own");
        lines.push("finding). For the both-ways-confirmed points, VanHelsing's effective no-op is");
    }
    lines.push("economically CORRECT, and the only defect is attempting (paying gas for) a");
    lines.push("provably-losing drive instead of cleanly detecting NO_ARB. LOW severity (gas-only, never");
    lines.push("a real dislocation left undefended). Mechanism (A) lives entirely in the fee-aware");
    lines.push("`MeetingPrice.meet` (the harness's 8-arg `meetBoth`), NOT the fee-free `target()` that");
    lines.push("`meeting-price.test.js`'s \"overshoot fix\" test covers: that formula is a plain weighted");
    lines.push("average of the two sqrt prices, so it cannot leave `[sd, sa]` by construction.");
    lines.push("");
    lines.push("**Status (measured 2026-07-08): the interval clamp, then the balance-scaled quote and");
    lines.push("the capacity cap.** Without the clamp, `meet`'s gamma wedge (`sdFinal = gamma * saf`,");
    lines.push("`gamma = 1/sqrt((nd/dd)(na/da))` always > 1, fees are always a discount) could push a");
    lines.push("computed final OUTSIDE `[min(sd,sa), max(sd,sa)]` whenever the fee-implied kick");
    lines.push("`sd*(gamma-1)` exceeded the actual dislocation `sd-sa`; `VanHelsing._restore`'s");
    lines.push("exact-equality guard (`require(cur != target, \"NO_ARB\")`) did not catch that near-miss,");
    lines.push("so it proceeded to a real, provably-losing drive. `MeetingPrice._clampIv` (the interval");
    lines.push("clamp in `MeetingPrice.sol`) pins every computed final into that interval and");
    lines.push("eliminated that exact sub-mechanism: 909 (without the clamp) -> 126 (with it, before the");
    lines.push("quote and cap changes), and EVERY non-stable-leg pair (V2/V2, V2/conc, conc/V2,");
    lines.push("conc/conc: 537 of the original 909) was fully eliminated, zero mechanism-(A) overshoots.");
    lines.push("The clamp alone did not bring the count to ~0 with only below-floor survivors: 126");
    lines.push("points remained (1 V2/stable, 68 conc/stable, 57 stable/conc), every one with a `meet`");
    lines.push("target GENUINELY INSIDE `[min(sd,sa), max(sd,sa)]`, where the clamp correctly does");
    lines.push("nothing. The loss instead traced to the stableswap price/depth read being slightly off");
    lines.push("near the fee boundary, feeding `meet` an in-interval pair of prices whose");
    lines.push("weighted-average target still missed where the pool's true nonlinear curve would");
    lines.push("restore to. The stableswap design that shipped (a directional-secant depth was measured");
    lines.push("first and REJECTED; see mechanism (C)) keeps the tangent depth, balance-scales the");
    lines.push("unit-quote probe, and caps the depth by what the pool can pay over the restore. The cap");
    lines.push("binds only MILDLY at these points (measured ~0.64-0.9x of the tangent, fee-tier");
    lines.push("dependent: the 0.05% interval plus the fee-implied offset of the stable's own quote");
    lines.push("price sits just past the tangent's honest reach), and a mild depth reduction cannot");
    lines.push("collapse (A): it shrinks the doomed drive but the meet target stays strictly interior,");
    lines.push("so `_restore`'s `cur != target` check still proceeds. Collapsing (A) outright needs a");
    lines.push("NO_ARB detection that sees these interior targets; the fee check (`MeetingPrice.noArb`)");
    lines.push("runs before sizing but fires only where the clamp would pin, so it leaves them (out of");
    lines.push("scope: gas-only, LOW). Of the stableswap changes, only the balance-scaled quote was");
    lines.push("expected to move (A).");
    lines.push("");
    if (noArbAttempted.length === 0) {
        lines.push("Measured with the quote and cap changes: fully collapsed, 126 -> 0.");
    } else {
        // Per-pair breakdown of the 126 measured with the clamp alone (2026-07-08): 1 V2/stable,
        // 68 conc/stable, 57 stable/conc. Compared LIVE below against this run's own per-pair
        // counts, not repeated as a hardcoded assumption.
        const before126 = { "V2/stable": 1, "conc/stable": 68, "stable/conc": 57 };
        const afterByPair = Object.fromEntries(
            Object.keys(before126).map((label) => [label, noArbAttempted.filter((p) => p.pair === label).length]),
        );
        const moveTxt = Object.keys(before126)
            .map((label) => `${label} ${before126[label]} -> ${afterByPair[label]}`)
            .join(", ");
        lines.push(`Measured with the quote and cap changes: a LOW-severity residual remains, 126 -> ${noArbAttempted.length} (${moveTxt}).`);
        lines.push(`Every remaining point still reads \`optimalProfit <= 0\` (gas-only, no real arb lost:`);
        lines.push("the same fee that breaks the sizing also makes the dislocation unprofitable for any");
        lines.push("external actor) and, as a SUBSET of the 126 points verified genuinely interior with the");
        lines.push("clamp alone (removing points from a set cannot make the remaining ones newly");
        lines.push("out-of-interval), still has a genuinely in-interval `meet` target (the worked example");
        lines.push(`below checks this live, for this run's own example point). ${noArbAttempted.length - noArbAttemptedDust.length} of ${noArbAttempted.length} read ABOVE the precision`);
        lines.push("floor, so they are not 1-wei rounding artifacts. They trace to the residual");
        lines.push("near-fee-boundary imprecision of the stableswap price/depth read, which nothing in the");
        lines.push("sizing targets at sub-fee dislocations: the capacity cap cannot bind there by design");
        lines.push("(see the Status paragraph above), and that is the correct trade. These are gas-only");
        lines.push("no-ops, accepted as a documented LOW residual rather than chased with a near-peg change");
        lines.push("that would risk the accurate 82.4% fork behavior.");
    }
    if (exampleA) {
        lines.push("");
        lines.push("Worked example from this run: " + regionOf(exampleA) + `, depthRatio=${exampleA.depthRatio}, fee=${exampleA.fee}.`);
        lines.push(`Chosen drive ${exampleA.chosen} realizes profit ${exampleA.chosenProfit} (negative) while the golden search's`);
        lines.push(`optimal over the whole range is ${exampleA.optimalProfit} in the driven direction and ${exampleA.optimalProfitReverse} in the`);
        lines.push("reverse direction: both non-positive, so no real arb existed and the sizer should");
        lines.push("have chosen not to drive at all.");
        if (exampleADetail) {
            const { ratio, sd, sa, lo, hi, sdFinal, saFinal, interior } = exampleADetail;
            const ratioTxt = ratio == null ? "several times" : `about ${ratio.toFixed(1)}x`;
            lines.push("");
            if (interior) {
                lines.push(`Live check for this point: sd=${sd}, sa=${sa} (interval [${lo}, ${hi}]); \`meet\``);
                lines.push(`returns sdFinal=${sdFinal}, saFinal=${saFinal}, BOTH strictly inside it, neither pinned`);
                lines.push(`to either edge, so the clamp never engages here. Gamma's kick is only ${ratioTxt} the`);
                lines.push("dislocation, far too small to push the target outside the interval, consistent");
                lines.push("with the clamp being a no-op here.");
                lines.push("The loss traces to the stable leg's price/depth coming out of `CurveLib`");
                lines.push("slightly off near the fee boundary, not to an out-of-interval target.");
            } else {
                lines.push(`Live check for this point: sd=${sd}, sa=${sa} (interval [${lo}, ${hi}]); \`meet\` returns`);
                lines.push(`sdFinal=${sdFinal}, saFinal=${saFinal}: at least one final IS pinned to an interval edge`);
                lines.push(`here, unlike the general ${noArbAttempted.length}-survivor case this section describes`);
                lines.push("(verified genuinely interior by direct harness inspection when the clamp was");
                lines.push("added); this particular example happens to be a boundary case instead.");
            }
        }
    }
    if (reversePositive.length > 0) {
        lines.push("");
        lines.push(`Reverse-direction-positive points (${reversePositive.length}, split out of (A), never absorbed; a below-floor`);
        lines.push("tag means the reverse optimum is under BASE_L/1e12, i.e. rounding dust, not a missed");
        lines.push("arb, while an ABOVE-floor entry is a genuine drove-the-wrong-way defect):");
        for (const p of reversePositive) {
            const dustTag = p.optimalProfitReverse < baseLOf(p.baseL) / DUST_DIV ? " [below the precision floor]" : " [ABOVE THE PRECISION FLOOR: REAL]";
            lines.push(`- ${regionOf(p)}, depthRatio=${p.depthRatio}, fee=${p.fee}: optimalProfit(driven dir)=${p.optimalProfit}, optimalProfit(reverse)=${p.optimalProfitReverse}${dustTag}`);
        }
    }
    lines.push("");
    lines.push(`**(B) Conc-cliff depth-walk over-sizing: \`optimalProfit > 0\`, no stable leg (${realArbLostCliff.length} of ${overshoots.length} overshoots; ${pairsIn(realArbLostCliff)}; by dislocation: ${dislocBreakdown(realArbLostCliff)}).**`);
    if (realArbLostCliffDust.length > 0) {
        lines.push(`(${realArbLostCliffDust.length} of the ${realArbLostCliff.length} sit below the precision floor: rounding-dust optima at the`);
        lines.push("huge-depth slice, tagged in the full list below and analyzed under Absolute-depth");
        lines.push("slices; the mechanism description here is about the above-floor points.)");
    }
    lines.push("SERIOUS: a genuinely exploitable dislocation goes UNDEFENDED (VanHelsing over-sizes");
    lines.push("into a loss, the drive reverts, and the ward is a silent no-op). Here the dislocation");
    lines.push("IS large enough to be genuinely profitable (`optimalProfit` is real, often large). But");
    lines.push("when the bounded depth-walk (`V3Depth.effectiveLiquidity`, the SHIPPED walk VanHelsing");
    lines.push("sizes from) walks a cliff-shaped leg from its own current price toward the far-away");
    lines.push("dislocated price, it walks past that leg's configured core+skirt and into a region with");
    lines.push("NO further liquidity. The walk's own span-weighted average then reports absorbable");
    lines.push("liquidity PAST the leg's actual configured range, reading far below the leg's near-spot");
    lines.push("depth. `MeetingPrice` sizes the drive off that (correctly walked, but now unrepresentative)");
    lines.push("average, choosing an input several times bigger than what the leg can actually absorb");
    lines.push("before running dry: the real swap falls short of the amount owed back to the driven");
    lines.push("pool.");
    lines.push("");
    const bAboveLive = realArbLostCliff.filter((p) => !realArbLostCliffDust.includes(p));
    const bUnder10Live = bAboveLive.filter((p) => p.dislocation !== "50%").length;
    const b50Live = bAboveLive.filter((p) => p.dislocation === "50%").length;
    // Dated baseline (2026-07-08): mechanism (B)'s above-floor counts with pass-1 sizing
    // alone, the interval clamp already in place. 252 is the TOTAL above-floor count, never
    // the <=10% count alone: the <=10% slice was 135 (18+63+54 by dislocation) and the 50%
    // tail 117. Kept as plain literals, not derived from any live array (the pass-1-only
    // grid is not rebuilt to recompute them), so the "before" side of every ratio below is
    // exact and dated.
    const bBeforeTotal = 252, bBeforeUnder10 = 135, bBefore50 = 117;
    const bTotalCutPct = Math.round(((bBeforeTotal - bAboveLive.length) * 100) / bBeforeTotal);
    const bUnder10CutPct = Math.round(((bBeforeUnder10 - bUnder10Live) * 100) / bBeforeUnder10);
    // Aggregate capture figures for the prose below, computed LIVE every run, so the
    // "after" side cannot drift from the data the way a hardcoded literal would. Mean: a
    // plain average of every point's own capture fraction (already a float, like
    // median/worst above), a display statistic, not money math. Value-weighted: real BigInt
    // money math over the point records, sum(chosenProfit, floored at 0 the same way a single
    // point's own capture clamps a losing chosen size) over sum(optimalProfit), across only
    // the points with a genuine positive optimum (an optimalProfit <= 0 point has nothing to
    // weight by: mechanism (A)'s own domain). The /10000n and the final /10000 happen only
    // in the last step, for display, the same discipline captureOf in capture.js uses.
    const bMeanBefore = 0.8903, bVwBefore = 0.8627; // dated 2026-07-08: pass-1 sizing alone
    const aggregateMeanLive = captures.reduce((a, b) => a + b, 0) / captures.length;
    const posOptPoints = points.filter((p) => p.optimalProfit > 0n);
    const sumChosenClamped = posOptPoints.reduce((s, p) => s + (p.chosenProfit > 0n ? p.chosenProfit : 0n), 0n);
    const sumOptimalPos = posOptPoints.reduce((s, p) => s + p.optimalProfit, 0n);
    const valueWeightedLive = sumOptimalPos > 0n
        ? Math.min(1, Number((sumChosenClamped * 10000n) / sumOptimalPos) / 10000)
        : null;
    lines.push("**Status (measured 2026-07-08): SUBSTANTIALLY FIXED by the directional two-pass");
    lines.push("combine.** Each concentrated leg is re-walked a second time bounded at its OWN pass-1");
    lines.push("meeting price (the real, shorter restore segment) and combined DIRECTIONALLY with its");
    lines.push("pass-1 read: the DRIVER keeps `max(pass1, pass2)` (never re-walk it down; a cliffy");
    lines.push("driver's short own-meet walk stays in its deep core instead of diluting with the skirt,");
    lines.push("recovering the core depth), the SINK keeps `min(pass1, pass2)` (the shorter segment");
    lines.push("reveals LESS absorbable depth, the conservative read that fixes the sink's over-absorb).");
    lines.push("This is `VanHelsing._pass2`, which `capture.js`'s `twoPassCombine` reproduces wei-exact");
    lines.push("(the V3/V4/stable calibration gates pass bit-for-bit under it). A SCALAR geometric-mean");
    lines.push("combine was measured first across weights w in {0, .25, .5, .75, 1} and REJECTED: it");
    lines.push("introduced a NEW thin-active driver over-size (a deep driver that barely moves reads its");
    lines.push("own thin ACTIVE notch on the re-walk, and `meet` then places the target far past the");
    lines.push("notch and over-drives), and no scalar weight escaped it. The parameter-free directional");
    lines.push("max/min kills that thin-active class ENTIRELY (zero new overshoots vs the pass-1");
    lines.push(`baseline) and cuts mechanism (B)'s above-floor total ${bBeforeTotal} -> ${bAboveLive.length} (a ${bTotalCutPct}% cut).`);
    lines.push(`Split by dislocation: the <= 10% slice, the actionable band, drops ${bBeforeUnder10} -> ${bUnder10Live}`);
    lines.push(`(a ${bUnder10CutPct}% cut); the 50% tail (a documented one-damped-step linearization limit, not a live`);
    lines.push(`defect; see the residue bullets below) eases ${bBefore50} -> ${b50Live}. Capture is up in step`);
    lines.push(`(aggregate mean ${fmtPct(bMeanBefore)} -> ${fmtPct(aggregateMeanLive)}, value-weighted ${fmtPct(bVwBefore)} ->`);
    lines.push(`${valueWeightedLive == null ? "n/a" : fmtPct(valueWeightedLive)}, both measured live on this run against a dated pass-1-only`);
    lines.push("baseline). An earlier full-range capacity-weighted MEAN walk was a different, rejected");
    lines.push("attempt: it under-read a deep driver's core 4x-40x and regressed two committed fork");
    lines.push("gates, so it never shipped.");
    lines.push("");
    lines.push(`The residue, ${bAboveLive.length} above-floor points, is two documented, funds-safe populations,`);
    lines.push("each pinned precisely by this suite's guard:");
    lines.push(`- **${bUnder10Live} at <= 10% dislocation: a concentrated-SINK CAPACITY CEILING** (a DIFFERENT`);
    lines.push("  mechanism from the sink-walk over-read the two-pass combine fixes). A cliff-shaped");
    lines.push("  concentrated DRIVER against a SHALLOWER conc/V2 SINK (depthRatio 1e-1 or 1e-3) whose");
    lines.push("  marginal L (pass-1 OR pass-2, since the sink takes the shallower min) still");
    lines.push("  over-promises a HARD absorbable-capacity bound the linear meeting-price model cannot");
    lines.push("  express. Attribution measured 2026-07-08 by a substitution experiment: forcing the");
    lines.push("  driver to its pass-1 read does NOT heal these (unlike the thin-active class, which");
    lines.push("  flipped safe that way), and the sink is already at its shallowest available marginal");
    lines.push("  read, so no marginal-L combine of either leg fixes them. A capacity cap for");
    lines.push("  CONCENTRATED sinks would fix them, as the stableswap capacity cap does for STABLE");
    lines.push("  sinks: a cap, not a better slope, is what solves this shape. VanHelsing has no such");
    lines.push("  cap, so the guard pins these.");
    lines.push(`- **${b50Live} at 50% dislocation: the one-damped-step linearization limit.** A single pass-2`);
    lines.push("  step does not reach the converged own-meet fixed point across a 50% price gap, and this");
    lines.push("  tail is accepted as a documented limit. `depth-budget.test.js` measures the own-meet");
    lines.push("  fixed point recovering the marginal core depth (real V4 recovery 1.446x, a cliffy");
    lines.push("  mock's L_true landing on the exact core 1.0001e24), so further damped steps would");
    lines.push("  shrink this tail if it were ever worth the gas.");
    lines.push("");
    lines.push("Funds-safe exactly like (A) and (C): an over-sized drive cannot lose money. The flash");
    lines.push("swap fails its own repay check and the whole `execute()` frame reverts (VanHelsing is");
    lines.push("fundless), and `ward()` swallows that revert. The gap costs a missed defense on this");
    lines.push("attempt, never a fund loss.");
    if (exampleB) {
        lines.push("");
        lines.push("Worked example from this run: " + regionOf(exampleB) + `, depthRatio=${exampleB.depthRatio}, fee=${exampleB.fee}.`);
        lines.push(`Chosen drive ${exampleB.chosen} (${(Number(exampleB.chosen * 10000n / exampleB.optimalSize) / 10000).toFixed(2)}x the optimal size ${exampleB.optimalSize}) realizes`);
        lines.push(`profit ${exampleB.chosenProfit} against a genuinely achievable optimal of ${exampleB.optimalProfit}.`);
    }
    lines.push("");
    lines.push(`**(C) The stable-pair bucket: \`optimalProfit > 0\`, a stable leg present (${realArbLostStable.length} of ${overshoots.length} overshoots; ${pairsIn(realArbLostStable)}; by dislocation: ${dislocBreakdown(realArbLostStable)}). Stable-sink tangent saturation over-sizing, closed by the capacity cap; then a driver-attributed residue, healed by the directional two-pass combine and the driver-first meeting (54 -> ${cAboveFloor} above-floor)${cAboveFloor === 0 ? "" : "; what remains is the stable-sink 50% linearization tail"}.**`);
    if (realArbLostStableDust.length > 0) {
        lines.push(`(${realArbLostStableDust.length} of the ${realArbLostStable.length} sit below the precision floor; see the note under (B).)`);
    }
    lines.push("Also SERIOUS, and a DIFFERENT mechanism from (B) even though both involve a depth");
    lines.push("estimate going stale: a stableswap can never drive (no flash mode: `resolveDriver`");
    lines.push("always makes it the sink when present, see buildPair), so every one of these overshoots");
    lines.push("is about the SINK side over-absorbing, never a walked range running dry.");
    lines.push("");
    lines.push(`**Status (measured 2026-07-08): closed by a capacity cap on the stable leg's depth, raw`);
    lines.push(`count 217 (before the cap) -> ${realArbLostStable.length}.** The mechanism: \`CurveLib.depth\`'s`);
    lines.push("amplified near-peg TANGENT over-states the stable pool's absorbable depth by orders of");
    lines.push(`magnitude (${cpMultiple.toFixed(0)}x the naive \`sqrt(b0*b1)\` constant-product fallback, measured`);
    lines.push("by this run's own stableNormalizeModel sanity check on its 3:4-imbalanced pool; the");
    lines.push("committed assertion is the floor > 100x, see CALIBRATION) once the sizing drive");
    lines.push("approaches the pool's own balances near saturation; without the cap, `meet` targeted a");
    lines.push("near-full restore and the chosen drive's output exceeded the sink's ENTIRE balance. A");
    lines.push("first attempt replaced the tangent with a min of two directional secants; measurement");
    lines.push("REJECTED it (2026-07-08): it read MORE conservative on the accurate near-peg fork case");
    lines.push("(capture 82.4% -> 71.4%, below the committed 0.82 floor) while STILL leaving 264");
    lines.push("above-floor survivors here: no slope-only L, however probed, can encode a hard capacity");
    lines.push("bound. The shipped design keeps the tangent and bounds it where the restore's price");
    lines.push("interval is actually known: `CurveLib.depth` (reproduced as `capStableL` in capture.js)");
    lines.push("caps a stable leg's L so the linear model's implied output over the whole interval");
    lines.push("`[min(sd,sa), max(sd,sa)]` cannot exceed HALF the output-side balance. The cap scales");
    lines.push("as balance/interval-width. On the real 82.4% fork case it does not bind at all (that");
    lines.push("pool is imbalanced, so its tangent reads only ~200x its balances against a ~3.8x-larger");
    lines.push("cap; a dedicated unit test also pins a synthetic near-peg non-binding case), so the");
    lines.push("near-peg behavior is preserved by construction. On this sweep's peg-balanced stable");
    lines.push("legs (tangent ~940-1110x balances) it binds on every point: mildly at 0.05% (~0.64-0.9x");
    lines.push("the tangent, fee-dependent), and by orders of magnitude at the large-dislocation");
    lines.push("ratio-extreme points where the tangent over-promised the pool's entire balance many");
    lines.push("times over.");
    lines.push("");
    if (cAboveFloor === 0) {
        lines.push(`Measured with the cap: every remaining stable-sink overshoot (${realArbLostStable.length} total, all below the`);
        lines.push("precision floor) is rounding dust, not a material saturation loss.");
    } else {
        const cAboveShapes = [...new Set(cAboveFloorPts.map((p) => p.shape))].sort().join(", ");
        lines.push(`Measured with the two-pass combine: the driver-attributed portion of this bucket is HEALED,`);
        lines.push(`54 -> ${cAboveFloor} above-floor. A substitution experiment had attributed the 54 above-floor`);
        lines.push("survivors here (replacing the conc DRIVER's walked L with its representative near-spot");
        lines.push("depth flipped every one to a profitable, non-overshooting drive) to the cliff-shaped");
        lines.push("conc DRIVER's span-weighted walked depth under-reading its deep near-spot core:");
        lines.push("mechanism (B)'s cause on a stable-involving pair. The directional combine's driver =");
        lines.push("max(pass1, pass2) recovers exactly that core on the 2% and 10% cells, and they are now");
        lines.push("gone from this bucket. The");
        lines.push(`${cAboveFloor} that remain are a SINGLE profile (by dislocation: ${dislocBreakdown(cAboveFloorPts)};`);
        lines.push(`shapes: ${cAboveShapes}; leg-ratio ${extremeRatioLabels.join("/")} extremes ${cAboveFloorExtreme} of ${cAboveFloor}, ${cAboveFloorMatchedRatio} matched):`);
        lines.push("stable/conc, mild-cliff, 50% dislocation, extreme ratio, with the stable capacity cap");
        lines.push("BINDING. This is a DISTINCT residual from the concentrated-sink ceiling in mechanism");
        lines.push("(B): here the SINK is the stable leg (its cap already binds), and the survivor is the");
        lines.push("same one-damped-step 50% linearization tail as (B)'s own 50% population, on a stable");
        lines.push("pair: a single pass-2 step does not reach the converged fixed point across a 50% gap.");
        lines.push("Funds-safe (cap-bounded, over-size -> atomic revert -> undefended no-op, never a loss).");
        lines.push("The C-class guard PINS it precisely: every above-floor survivor must match that");
        lines.push(`stable-sink 50%-tail profile and the count must equal exactly ${cAboveFloor}, so any NEW`);
        lines.push("kind or any growth fails loudly. Further damped pass-2 steps, or a capacity cap for");
        lines.push("concentrated sinks, could shrink this 50% tail.");
    }
    if (exampleC) {
        lines.push("");
        lines.push("Worked example from this run: " + regionOf(exampleC) + `, depthRatio=${exampleC.depthRatio}, fee=${exampleC.fee}.`);
        lines.push(`Chosen drive ${exampleC.chosen} (${(Number(exampleC.chosen * 10000n / exampleC.optimalSize) / 10000).toFixed(2)}x the optimal size ${exampleC.optimalSize}) realizes`);
        lines.push(`profit ${exampleC.chosenProfit} against a genuinely achievable optimal of ${exampleC.optimalProfit}.`);
    }
    lines.push("");
    lines.push("All three mechanisms end the same way on-chain: the flash drive cannot repay itself, so");
    lines.push("the swap's own invariant check reverts the whole `execute()` frame (VanHelsing is");
    lines.push("fundless: invariant 1 in its header comment), and `ward()` swallows that revert");
    lines.push("(invariant 2). No funds are ever at risk in any case. The practical difference is");
    lines.push("materiality: (A) costs only wasted gas on a dislocation nobody could have profitably");
    lines.push("exploited anyway (the same fee that broke VanHelsing's sizing also made it unprofitable");
    lines.push("for any external attacker); (B) and (C) both mean a dislocation that WAS genuinely");
    lines.push("exploitable goes undefended for that ward. Both are now SUBSTANTIALLY smaller: the");
    lines.push(`directional two-pass combine cut (B) above-floor total ${bBeforeTotal} -> ${bAboveLive.length} (its <=10%-dislocation`);
    lines.push(`slice ${bBeforeUnder10} -> ${bUnder10Live}) and (C) above-floor 54 -> ${cAboveFloor}. What remains is characterized and`);
    lines.push(`funds-safe: (B)'s ${bUnder10Live} are a concentrated-SINK capacity ceiling (a capacity cap for`);
    lines.push(`concentrated sinks, which VanHelsing does not have, would collapse them), and ${cAboveFloor === 0 ? `(B)'s ${b50Live} are a` : `(B)'s ${b50Live} plus (C)'s ${cAboveFloor} are the same`}`);
    lines.push("one-damped-step 50%-dislocation linearization tail, accepted as a documented limit. See the");
    lines.push("mechanism (B) and (C) sections above for each pin.");
    lines.push("");

    lines.push("## OVERSHOOTS: full list (chosen drive size realizes negative profit)");
    lines.push("");
    if (overshoots.length === 0 && routeOvershoots.length === 0) {
        lines.push("None found in the main grid or the route sub-grid.");
    } else {
        const mechOf = (p) => (p.optimalProfit <= 0n ? "A" : p.pair.includes("stable") ? "C" : "B");
        // (A)'s floor is on chosenProfit (isDustA), not optimalProfit (isDust); see isDustA's
        // own comment. (B)/(C) keep the optimalProfit-based tag.
        const dustTag = (p) => (p.optimalProfit <= 0n
            ? (isDustA(p) ? " [chosenProfit below the precision floor]" : "")
            : (isDust(p) ? " [optimum below the precision floor]" : ""));
        for (const p of overshoots) {
            lines.push(`- [main, mechanism ${mechOf(p)}] ${regionOf(p)}, depthRatio=${p.depthRatio}, fee=${p.fee}, dir=${p.dir}: chosenProfit=${p.chosenProfit}, optimalProfit=${p.optimalProfit}${dustTag(p)}`);
        }
        for (const p of routeOvershoots) {
            lines.push(`- [route] hops=${p.hopShapes}, defKind=${p.defKind}, dislocation=${p.dislocation}: chosenProfit=${p.chosenProfit}, optimalProfit=${p.optimalProfit}`);
        }
    }
    lines.push("");

    lines.push("## Route sub-grid" + (routeReduced ? " (REDUCED)" : ""));
    lines.push("");
    if (routeReduced) {
        lines.push("The ALT-as-2-hop-route case (composite sizing via `RouteLibHarness`, engine profit");
        lines.push("chained through the two real hop models) is measured on a REDUCED sub-grid, not the");
        lines.push("full grid: 2 hop-shape combos (V2+V2, V2+conc-uniform) x 2 defended kinds (V2, conc,");
        lines.push("both uniform-shaped) x 3 dislocations (0.5%, 2%, 10%), fee fixed at each kind's");
        lines.push("typical tier and the defended depth fixed at 1e24 (the main grid's middle");
        lines.push("absolute-depth slice). Reduced because composing a real on-chain route (registry +");
        lines.push("2 mock hop pools + a route id/config, per hop-shape combo) is materially more setup");
        lines.push("than a direct leg, and the direct-path grid above already covers depth-ratio /");
        lines.push("dislocation / shape / fee sensitivity in full; this sub-grid instead answers a");
        lines.push("narrower question: does the shipped route composite sizing");
        lines.push("(RouteLib.normalize/effectiveLiquidity) carry over the same capture quality as a");
        lines.push("direct concentrated leg.");
        lines.push("");
    }
    if (routePoints.length === 0) {
        lines.push("No route points were collected.");
    } else {
        const rc = routePoints.map((p) => p.capture);
        lines.push(`- ${routePoints.length} points. Median capture: ${fmtPct(median(rc))}. Worst: ${fmtPct(Math.min(...rc))}.`);
        lines.push("");
        lines.push("| hops | defKind | dislocation | capture | overshoot |");
        lines.push("|---|---|---|---|---|");
        for (const p of routePoints) {
            lines.push(`| ${p.hopShapes} | ${p.defKind} | ${p.dislocation} | ${fmtPct(p.capture)} | ${p.overshoot} |`);
        }
        lines.push("");
    }

    lines.push("## Grid definition (for reproducibility)");
    lines.push("");
    lines.push("- Model pairs (defended/alt): " + PAIRS.map((p) => p.label).join(", ") + ".");
    lines.push("- Absolute depth (BASE_L, the defended leg's depth): " + BASE_LS.map((b) => b.label).join(", ") + ", a full grid");
    lines.push("  axis, swept rather than fixed at 1e24 so scale effects show apart from the leg RATIO.");
    lines.push("  The route sub-grid stays at 1e24, disclosed in its own section.");
    lines.push("- Leg-depth ratio (altL/defL): " + DEPTH_RATIOS.map((d) => d.label).join(", ") + ".");
    lines.push("- Dislocation (sqrt-price bump of the dislocated leg away from the anchor): " + DISLOCATIONS.map((d) => d.label).join(", ") + ".");
    lines.push("- Concentrated depth shapes: " + SHAPES.join(", ") + " (uniform: flat L over a wide range;");
    lines.push("  mild/sharp-cliff: a deep core +-100/+-10 raw ticks, thin skirt to +-2000; thin-active:");
    lines.push("  thin at the current tick, a deep neighbor one tick away on both sides).");
    lines.push("- Fee scenarios: typical / stress (the conc leg's 1% tier, only when a leg is actually");
    lines.push("  conc; omitted, not duplicated, for V2/V2 and V2/stable, which have no higher tier to");
    lines.push("  substitute) / zero-control, built per leg from V2 0.25%, V3 0.05%/1%, stable 0.04%, and");
    lines.push("  0% (see `feeScenarios`).");
    lines.push("- The DEFENDED leg is always the slice's depth reference (BASE_L); the ALT leg's");
    lines.push("  depth is BASE_L scaled by the depth ratio. The STABLE leg (if present) is always the");
    lines.push("  price anchor; otherwise the ALT anchors and the DEFENDED is the dislocated leg.");
    lines.push("- The depth-ratio axis is NOMINAL balances (b0 = b1 = the leg's depth, fed to");
    lines.push("  `buildStableAtPeg`/`stableModel`), the same construction used for a V2 leg's virtual");
    lines.push("  reserves; it is NOT the stable leg's SIZING-effective L. `CurveLib.depth`'s amplified");
    lines.push("  tangent reports a near-peg depth far above the nominal balances (see mechanism (C) above");
    lines.push("  and the `stableNormalizeModel` sanity test's own console output for this run's measured");
    lines.push("  multiple), roughly 1000x, so a stable leg's depth-ratio LABEL undersells how deep");
    lines.push("  `meet` actually treats it near peg.");
    lines.push("");

    return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

describeFork("Van Helsing capture-quality grid sweep", function () {
    let conn, h, me;
    let mainPoints = [], regions = [], wallMs = 0;
    let routePoints = [], routeWallMs = 0;
    let exampleADetail = null;
    const ROUTE_REDUCED = true;

    before(async function () {
        this.timeout(60000);
        // plain local network, no fork. `forking.enabled: false` matters, not just
        // omitting an override: the shared hardhat.config.js's "hardhat" network has a
        // live forking URL/blockNumber baked into its base definition (for the OTHER
        // fork tests in this repository), so a bare `network.create({ network: "hardhat" })`
        // still forks by default and pays a real RPC round trip on every state-changing
        // call (measured: ~650ms per call, ~3s for 4 sequential `setTick`s, enough to
        // blow the whole sweep's time budget at 1000+ points). Disabling forking here
        // brings that to ~1ms per call.
        conn = await network.create({ network: "hardhat", override: { forking: { enabled: false } } });
        [me] = await conn.ethers.getSigners();
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const routeLib = await deploy(conn, "RouteLibHarness", null, [], { libraries: { V3Depth: null, V4Depth: null, RouteLib: null } });
        h = { mp, v3depth, routeLib, conn, poolCache: new Map() };
    });

    it("stableNormalizeModel sanity: matches an independent transcription of CurveLib.sol's formula", function () {
        // Independent re-derivation of CurveLib's price() and tangent depth formulas (its
        // own inline expressions, not a call to stableModelDepth/stableNormalizeModel in
        // pool-model.js, so this is not just calling the same code path twice), checked
        // against a balanced and an imbalanced pool. This is a fork-free arithmetic check
        // of the PORT; the underlying stableOut it calls has its own wei-exact fork
        // calibration in measure-stable.test.js, and CALIBRATION above documents the
        // boundary.
        //
        // The price probe is balance-scaled (b0/1000, capped at 1e18) rather than fixed at
        // 1e18. The depth is the near-peg TANGENT fit from a b0/100 reference trade (a
        // directional-secant depth was measured and rejected); its saturation
        // over-statement is bounded by the capacity cap at the end of CurveLib.depth
        // (capStableL in capture.js), which this transcription leaves out.
        //
        // s1's two divisions are kept SEQUENTIAL (not combined into one
        // `(dy*Q96*Q96)/(refDx*s0)`), matching CurveLib.sol's own nested
        // `fullMulDiv(fullMulDiv(dy, 1<<96, refDx), 1<<96, s0)` exactly: the real contract
        // floors the inner division before the outer one, so a single combined division
        // (more precise, but not what the contract computes) rounds a few wei differently
        // and would make this "independent" check disagree with a faithful port over
        // nothing but rounding order.
        function independent(b0, b1, A, feeNum, feeDen) {
            const m = stableModel(b0, b1, A, feeNum, feeDen);
            let dxU = b0 / 1000n; if (dxU > ONE) dxU = ONE;
            const dyU = dxU === 0n ? 0n : stableOut(m, dxU, true);
            const s0 = isqrt((dyU * Q192) / dxU);
            const refDx = b0 / 100n;
            const dy = stableOut(m, refDx, true);
            const s1 = ((dy * Q96) / refDx) * Q96 / s0;
            const l = (s1 === 0n || s1 >= s0) ? isqrt(b0 * b1) : (dy * Q96) / (s0 - s1);
            return { s: s0, l };
        }
        const A = 1000n, feeNum = 9996000000n, feeDen = 10000000000n;

        const b = 1_000_000n * ONE;
        const balanced = stableNormalizeModel(stableModel(b, b, A, feeNum, feeDen));
        const balancedRef = independent(b, b, A, feeNum, feeDen);
        expect(balanced.s).to.equal(balancedRef.s);
        expect(balanced.l).to.equal(balancedRef.l);
        // near peg: s should read very close to Q96 (1:1)
        expect(Math.abs(Number(balanced.s * 10000n / Q96) / 10000 - 1)).to.be.lt(0.01);

        const b0 = 300_000n * ONE, b1 = 400_000n * ONE; // same 3:4 imbalance as measure-stable.test.js
        const imbalanced = stableNormalizeModel(stableModel(b0, b1, A, feeNum, feeDen));
        const imbalancedRef = independent(b0, b1, A, feeNum, feeDen);
        expect(imbalanced.s).to.equal(imbalancedRef.s);
        expect(imbalanced.l).to.equal(imbalancedRef.l);
        // A-aware: price stays near peg despite the imbalance (not the raw 4/3 balance ratio)
        expect(Math.abs(Number(imbalanced.s * 10000n / Q96) / 10000 - 1)).to.be.lt(0.01);
        // amplified: L is far deeper than the naive constant-product sqrt(b0*b1) fallback
        const cpFallback = isqrt(b0 * b1);
        expect(imbalanced.l).to.be.gt(cpFallback * 100n);
        console.log(`  [stableNormalizeModel sanity] balanced s=${balanced.s} l=${balanced.l}; imbalanced s=${imbalanced.s} l=${imbalanced.l} (${Number(imbalanced.l * 10000n / cpFallback) / 10000}x the CP fallback)`);
    });

    it("builds the grid, sizes every point, and writes the capture-quality report", async function () {
        this.timeout(300000);
        const t0 = Date.now();
        const points = [];
        for (const pair of PAIRS) {
            const shapes = shapesFor(pair);
            const scenarios = feeScenarios(pair);
            for (const baseL of BASE_LS) {
                for (const depthRatio of DEPTH_RATIOS) {
                    for (const dislocation of DISLOCATIONS) {
                        for (const shape of shapes) {
                            for (const fees of scenarios) {
                                const { defended, alt } = buildPair(pair, depthRatio, dislocation, shape, fees, baseL.L);
                                const dir = await computeDir(h, defended, alt);
                                const r = await captureFraction(h, defended, alt, dir);
                                expect(
                                    Number.isFinite(r.capture),
                                    `NaN capture at ${pair.label}/${shape}/${dislocation.label}/${depthRatio.label}/${fees.label}/L=${baseL.label}`,
                                ).to.equal(true);
                                // Does the stableswap capacity cap bind on this point's stable
                                // leg? Recomputed from the same models the sizing used
                                // (capStableL reproduces the cap in CurveLib.depth), recorded so
                                // the report and the shape-baseline guard can tag documented
                                // cap-bound under-drives without re-deriving legs later.
                                const stableLeg = defended.kind === "stable" ? defended : alt.kind === "stable" ? alt : null;
                                let capBound = false;
                                if (stableLeg) {
                                    const sn = stableNormalizeModel(stableLeg);
                                    const so = sqrtPriceOf(stableLeg === defended ? alt : defended);
                                    capBound = capStableL(stableLeg, sn.l, sn.s, so) < sn.l;
                                }
                                points.push({
                                    pair: pair.label, shape, dislocation: dislocation.label, baseL: baseL.label,
                                    depthRatio: depthRatio.label, fee: fees.label, dir, capBound, ...r,
                                });
                            }
                        }
                    }
                }
            }
        }
        wallMs = Date.now() - t0;
        mainPoints = points;
        regions = aggregateRegions(points);
        console.log(`  [sweep] ${points.length} points, ${regions.length} regions, ${(wallMs / 1000).toFixed(1)}s wall time`);

        // Mechanism (A)'s worked example needs its real gamma-kick-vs-dislocation ratio AND a
        // live interior/pinned check (see mechanismADetail's own header comment), computed
        // here (not inside buildReport, which is a pure sync function) because it replays
        // harness calls and needs `h`.
        // classifyOvershoots picks the same exampleA deterministically (first no-arb-
        // attempted point in insertion order), so re-deriving it from the point's own
        // recorded labels reproduces the identical point buildReport will also select.
        const cls = classifyOvershoots(points);
        if (cls.exampleA) {
            const p = cls.exampleA;
            const pairObj = PAIRS.find((pp) => pp.label === p.pair);
            const depthRatioObj = DEPTH_RATIOS.find((d) => d.label === p.depthRatio);
            const dislocationObj = DISLOCATIONS.find((d) => d.label === p.dislocation);
            const feesObj = feeScenarios(pairObj).find((f) => f.label === p.fee);
            const baseLObj = BASE_LS.find((b) => b.label === p.baseL);
            exampleADetail = await mechanismADetail(h, pairObj, depthRatioObj, dislocationObj, p.shape, feesObj, baseLObj.L);
            const r = exampleADetail.ratio;
            console.log(`  [mechanism A] worked example: sd=${exampleADetail.sd} sa=${exampleADetail.sa} sdFinal=${exampleADetail.sdFinal} saFinal=${exampleADetail.saFinal} interior=${exampleADetail.interior} gamma-kick/dislocation ratio=${r == null ? "n/a" : r.toFixed(2) + "x"}`);
        }
        console.log(`  [overshoot classification] no-arb-attempted=${cls.noArbAttempted.length} (both-dirs-confirmed=${cls.noArbBothDirs.length}, reverse-positive=${cls.reversePositive.length}, of which dust=${cls.reversePositiveDust.length}) real-arb-lost=${cls.realArbLost.length} (cliff=${cls.realArbLostCliff.length}, stable-saturation=${cls.realArbLostStable.length}; below-floor=${cls.realArbLostCliffDust.length + cls.realArbLostStableDust.length})`);
    });

    it("route sub-grid (REDUCED): 2-hop ALT route capture", async function () {
        this.timeout(120000);
        const t0 = Date.now();
        const combos = [
            { label: "V2+V2", hop1Kind: "v2", hop2Kind: "v2" },
            { label: "V2+conc-uniform", hop1Kind: "v2", hop2Kind: "conc" },
        ];
        const defKinds = ["v2", "conc"];
        const dislocations = DISLOCATIONS.filter((d) => ["0.5%", "2%", "10%"].includes(d.label));

        const out = [];
        for (const combo of combos) {
            const route = await setupRoute(conn, me, combo.hop1Kind, combo.hop2Kind);
            for (const defKind of defKinds) {
                for (const dislocation of dislocations) {
                    const p = await routePoint(h, defKind, route, dislocation, combo.label);
                    expect(Number.isFinite(p.capture), `NaN route capture at ${combo.label}/${defKind}/${dislocation.label}`).to.equal(true);
                    out.push(p);
                }
            }
        }
        routeWallMs = Date.now() - t0;
        routePoints = out;
        console.log(`  [route sub-grid, REDUCED] ${out.length} points, ${(routeWallMs / 1000).toFixed(1)}s wall time`);
    });

    it("writes docs/measurements/vanhelsing-capture.md and logs the headline", function () {
        expect(mainPoints.length, "main grid must have run first").to.be.gt(0);
        const report = buildReport({ points: mainPoints, regions, routePoints, routeReduced: ROUTE_REDUCED, exampleADetail });

        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, report);

        const stat = fs.statSync(REPORT_PATH);
        expect(stat.size, "report file must be non-empty").to.be.gt(0);

        const captures = mainPoints.map((p) => p.capture);
        const overallMedian = median(captures), overallWorst = Math.min(...captures);
        const degraded = regions.filter((r) => r.worst < 0.90);
        console.log(`  [HEADLINE] overall median capture=${fmtPct(overallMedian)} worst=${fmtPct(overallWorst)} degraded regions=${degraded.length}/${regions.length}`);
        console.log(`  report written to ${REPORT_PATH}`);
    });

    it("guard: no NaN, uniform-depth regions capture >= 95%, every overshoot is flagged", function () {
        // no NaN anywhere (also checked inline while building the grid; re-asserted here
        // against the collected arrays as a single, easy-to-read guard). safeJSON: plain
        // JSON.stringify throws on a BigInt field (chosenProfit/optimalProfit/chosen/
        // optimalSize all are), and that throw would fire unconditionally (chai evaluates
        // the message argument eagerly, even when the assertion passes), not just on a
        // real failure.
        const safeJSON = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        for (const p of mainPoints) expect(Number.isFinite(p.capture), safeJSON(p)).to.equal(true);
        for (const p of routePoints) expect(Number.isFinite(p.capture), safeJSON(p)).to.equal(true);

        // The report's grid total must equal the loop arithmetic (axes multiplied out per
        // pair, since shapes and deduped fee scenarios vary by pair): a report that says
        // "N points" while the loops actually produced M is a report-integrity failure.
        const expectedTotal = PAIRS.reduce((n, pair) => n + feeScenarios(pair).length * shapesFor(pair).length, 0)
            * BASE_LS.length * DEPTH_RATIOS.length * DISLOCATIONS.length;
        expect(mainPoints.length, "grid total must reconcile with the axis arithmetic").to.equal(expectedTotal);

        // The overshoot classification must partition exactly: (A) + (B) + (C) = all
        // overshoots, and (A)'s measured reverse-direction split must partition (A).
        const cls = classifyOvershoots(mainPoints);
        expect(cls.noArbAttempted.length + cls.realArbLost.length, "A + real-arb-lost = overshoots").to.equal(cls.overshoots.length);
        expect(cls.realArbLostCliff.length + cls.realArbLostStable.length, "B + C = real-arb-lost").to.equal(cls.realArbLost.length);
        expect(cls.noArbBothDirs.length + cls.reversePositive.length, "reverse-direction search must cover every (A) point").to.equal(cls.noArbAttempted.length);
        // Any reverse-direction optimum ABOVE the precision floor is a genuine sizer-drove-
        // the-wrong-way defect and must be triaged by a human, not just listed: fail loudly.
        // (Below-floor reverse positives are rounding dust at huge depth, reported and
        // tagged in the report and tolerated here; see the Absolute-depth slices section.)
        const realReverse = cls.reversePositive.filter((p) => !cls.reversePositiveDust.includes(p));
        expect(realReverse.length, `above-floor reverse-direction arbs found: ${realReverse.map(regionOf).join("; ")}`).to.equal(0);

        // Mechanism (A): the gas-only no-arb-attempted residual. The interval clamp
        // (MeetingPrice._clampIv) eliminated every non-stable-leg overshoot of this kind
        // (909 -> 126 with the clamp alone, then -> 117 with the stableswap quote and cap);
        // what remains is a LOW-severity sub-fee/gas-kick sub-mechanism, both directions
        // confirmed no-arb by the reverse golden search above, not a money-losing defect.
        // Pinned with <= (not the exact equality (C) uses) so a future improvement that
        // LOWERS the count never fails the suite, but any GROWTH (a regression of the
        // clamp's win) fails loudly instead of only showing up as changed report prose.
        // The fee check (MeetingPrice.noArb, run first in VanHelsing._meet and in capture.js's
        // noArb) sits in front of the sizer and fires only on already-no-arb points, so it is
        // capture-neutral here (the report is the same with or without it). A false bail
        // cannot GROW this pin or the (B)/(C) buckets: it drives 0n on an optimalProfit > 0
        // point, so chosenProfit == 0 (not < 0) is not an overshoot; it can only SHRINK them.
        // It is caught instead by the uniform-depth >= 0.95 capture floor below (noArb is
        // shape-blind, so an over-wide wedge that swallows a real-arb cell also swallows that
        // cell's uniform sibling -> 0% capture there), by the exact-equality (B)/(C) pins
        // failing on shrink, and by the generated report changing.
        expect(cls.noArbAttempted.length, "mechanism (A) no-arb-attempted count grew past its shipped residual (117)").to.be.lte(117);

        // Shared precision floor for the (B)/(C) pins below.
        const floorOf = (p) => baseLOf(p.baseL) / DUST_DIV;

        // Mechanism (B) (conc-cliff over-sizing): SUBSTANTIALLY FIXED by the directional
        // two-pass combine (VanHelsing._pass2 / twoPassCombine: the driver keeps
        // max(pass1, pass2), the sink keeps min). Dated history (2026-07-08): 270 before the
        // interval clamp -> 252 with it -> the two-pass figures below. A SCALAR geometric-mean
        // combine was measured across weights w in {0, .25, .5, .75, 1} and REJECTED: it
        // introduced a NEW thin-active driver over-size (a deep driver's own-meet re-walk
        // collapsing into a thin active notch and over-driving). The parameter-free
        // directional max/min kills that: above-floor TOTAL 252 -> 141 (the <=10%-dislocation
        // slice, the actionable band, 135 -> 33; the 50% tail is a documented linearization
        // limit, 117 -> 108), ZERO new overshoots vs pass-1 (the thin-active class is gone).
        // Capture is up in step: a dated pass-1-only baseline (2026-07-08) measured aggregate
        // mean 89.03%, value-weighted 86.27%; see the report's mechanism (B) section,
        // regenerated every run, for this run's own live figures instead of a second,
        // driftable copy of them here.
        //
        // The residue is two documented, funds-safe populations, pinned precisely so any
        // NEW failure kind or any growth fails the suite loudly (the sweep is fully
        // deterministic: pure-BigInt models on a fresh local chain, no fork, no randomness):
        //  (i) 33 above-floor survivors at <= 10% dislocation: a concentrated-SINK CAPACITY
        //      CEILING, a DIFFERENT mechanism from the sink-walk over-read the combine fixes.
        //      A cliff-shaped concentrated DRIVER against a SHALLOWER conc/V2 SINK whose
        //      marginal L (pass-1 OR pass-2; the sink takes min) still over-promises a hard
        //      absorbable-capacity bound. Attribution measured 2026-07-08 by a substitution
        //      experiment over representative cells: forcing the driver to pass-1 does NOT
        //      heal them (unlike the thin-active class it does), and the sink is already at
        //      its shallowest available marginal read, so no marginal-L combine, of either
        //      leg, in either pass, expresses the bound. A capacity cap for CONCENTRATED
        //      sinks would express it, as the stableswap capacity cap does for STABLE sinks
        //      (a cap, not a better slope, is what solves this shape). VanHelsing has none;
        //      adding one should collapse these and tighten or remove this pin.
        //  (ii) 108 above-floor survivors at 50% dislocation: the one-damped-step
        //      linearization limit, accepted as a documented limit (a single pass-2 step
        //      does not reach the converged fixed point across a 50% price gap).
        // Both are funds-safe (over-size -> failed flash repay -> atomic revert -> undefended
        // no-op, never a loss).
        const bAbove = cls.realArbLostCliff.filter((p) => p.optimalProfit >= floorOf(p));
        const bUnder10 = bAbove.filter((p) => p.dislocation !== "50%");
        // concentrated-sink-capacity profile: a cliff-shaped conc DRIVER against a SHALLOWER
        // conc/V2 SINK (a stable leg can never drive, so a stable pair is never in this
        // bucket; a matched or driver-shallow ratio does not trip the sink ceiling).
        const bConcSinkProfile = (p) => (p.shape === "mild-cliff" || p.shape === "sharp-cliff")
            && (p.pair === "conc/conc" || p.pair === "conc/V2")
            && (p.depthRatio === "1e-3" || p.depthRatio === "1e-1");
        const bUnder10NonAttributed = bUnder10.filter((p) => !bConcSinkProfile(p));
        expect(
            bUnder10NonAttributed,
            `above-floor B survivors at <=10% OUTSIDE the concentrated-sink-capacity profile (a NEW mechanism, not the uncapped conc-sink residue): ${safeJSON(bUnder10NonAttributed.slice(0, 3))}`,
        ).to.have.length(0);
        expect(
            bUnder10.length,
            "above-floor B at <=10% must stay pinned at 33 (the concentrated-sink capacity ceiling; a capacity cap for conc sinks, like the stableswap one, would collapse these and remove the pin): any growth is a new finding",
        ).to.equal(33);
        const b50 = bAbove.filter((p) => p.dislocation === "50%");
        const b50NonCliff = b50.filter((p) => p.shape !== "mild-cliff" && p.shape !== "sharp-cliff");
        expect(
            b50NonCliff,
            `above-floor B survivors at 50% OUTSIDE the documented one-step cliff linearization tail: ${safeJSON(b50NonCliff.slice(0, 3))}`,
        ).to.have.length(0);
        expect(
            bAbove.length,
            "mechanism (B) above-floor count grew past its directional-combine floor (141 = 33 concentrated-sink-capacity at <=10% + 108 one-step linearization tail at 50%)",
        ).to.be.lte(141);

        // Mechanism (C) (stable-pair bucket): the stableswap capacity cap, the directional
        // two-pass combine and the driver-first meeting together leave no above-floor
        // residue. Dated history: raw 217 before the cap; a directional-secant depth was
        // tried and rejected; 57 total / 54 above-floor with the cap (driver-attributed); 9
        // with the directional combine (2026-07-08), whose driver = max read recovered the
        // cliff DRIVER's core on the 2%/10% cells that sat in this bucket; 0 (2026-10-27)
        // once the model met the driving pool first, as VanHelsing._finals does. The 9 had
        // all been stable/conc, mild-cliff, 50% dislocation, extreme ratio (dr=1e3), with the
        // stable cap binding: the model had sized the conc driver as the stableswap's sink.
        // Pinned by its profile + exact count so a new kind or any growth fails loudly.
        const cAbove = cls.realArbLostStable.filter((p) => p.optimalProfit >= floorOf(p));
        const cNonAttributed = cAbove.filter(
            (p) => !(p.shape === "mild-cliff" && p.pair === "stable/conc" && p.dislocation === "50%" && p.depthRatio === "1e3" && p.capBound),
        );
        expect(
            cNonAttributed,
            `above-floor C-bucket survivors OUTSIDE the stable-sink 50%-tail profile (a NEW mechanism): ${safeJSON(cNonAttributed.slice(0, 3))}`,
        ).to.have.length(0);
        expect(
            cAbove.length,
            "above-floor C-bucket count must stay pinned at 0 (the driver met first, as VanHelsing._finals meets it): any growth is a new finding",
        ).to.equal(0);

        // The capture clamp's self-policing flag (capture.js): a chosen profit beating the
        // golden search's optimum by more than a few wei means the optimizer under-found
        // the max, and every capture number would be silently inflated by the <=100% clamp.
        const underFound = [...mainPoints, ...routePoints].filter((p) => p.optimizerUnderFound);
        const underFoundLabel = (p) => (p.pair ? regionOf(p) : `route ${p.hopShapes}/${p.defKind}/${p.dislocation}`);
        expect(underFound.length, `goldenMax under-found the optimum at: ${underFound.map(underFoundLabel).join("; ")}`).to.equal(0);

        // Uniform-depth regions (no concentrated cliff at all: shape "uniform", or "n/a" for
        // a pair with no concentrated leg) capture >= 95%: the floor for the "nothing
        // pathological in the leg SHAPE" baseline, with exactly two documented exclusions.
        //
        // First documented exclusion: a worst point whose stable leg has the capacity cap
        // BINDING (p.capBound, recorded at grid-build time from the same capStableL the
        // sizing itself uses) and whose chosen drive did NOT overshoot. That is the cap's
        // designed trade-off at work: the cap bounds a stable sink's linearized depth by
        // what the pool can actually PAY over the restore interval, converting what would
        // otherwise be a guaranteed saturation overshoot (a total loss of the attempt) into
        // a funds-safe partial capture, with measured worst captures in the ~48-88% band at
        // ratio-extreme/large-dislocation points, at every absolute scale. A cap-bound point
        // that still OVERSHOOTS is never excused here (and the C-class guard above fails on
        // it anyway). No exclusion is needed for two older cases, both checked against this
        // run's data: a stable worst point overshooting with a real optimum (the cap
        // eliminated every uniform-shape saturation overshoot, so no region needs it), and a
        // stable leg with <= 1e20-wei balances under the old FIXED price probe (the
        // balance-scaled quote removed that breakdown, and those regions are now the same
        // cap-bound under-drives this exclusion documents; their captures are
        // scale-invariant, confirming the old probe artifact is gone).
        //
        // Second documented exclusion (for the absolute-depth axis): a worst point whose
        // positive optimum is BELOW THE PRECISION FLOOR (isDust: rounding noise at the 1e28
        // slice crossing the optimalProfit > 0 threshold on a ~0-optimum point). Its "0%
        // capture" divides SOME chosen profit that falls short of that dust target by a
        // dust denominator. It is not gated on overshoot, since a sub-fee point whose
        // dust-scale optimum lands where the fee check or the interval clamp no-ops chooses
        // a correctly-sized ZERO drive there (chosenProfit == 0, not a loss, so overshoot
        // reads false) and still divides out to the same meaningless 0%. The report tags
        // these in every list and the Absolute-depth slices section quantifies them. The
        // exclusion is precisely scoped to that tagged case, so a genuine above-floor
        // uniform-shape overshoot still fails the guard.
        for (const r of regions) {
            const isUniformDepth = r.shape === "uniform" || r.shape === "n/a";
            const isCapBoundUnderdrive = r.pair.includes("stable") && r.worstPoint.capBound && !r.worstPoint.overshoot;
            const isPrecisionFloorArtifact = isDust(r.worstPoint);
            if (isUniformDepth && !isCapBoundUnderdrive && !isPrecisionFloorArtifact) {
                expect(r.worst, `uniform-depth region ${r.key} worst capture`).to.be.gte(0.95);
            }
        }

        // Every overshoot (chosen size loses money) must show up in the report's
        // OVERSHOOTS section. That is true by construction (the report is built directly
        // from these same arrays' `overshoot` flag), and asserted here so a future refactor
        // that accidentally filters the list before rendering fails loudly.
        const overshoots = mainPoints.filter((p) => p.overshoot);
        const routeOvershoots = routePoints.filter((p) => p.overshoot);
        const report = fs.readFileSync(REPORT_PATH, "utf8");
        if (overshoots.length + routeOvershoots.length === 0) {
            expect(report).to.include("None found in the main grid or the route sub-grid.");
        } else {
            for (const p of overshoots) expect(report).to.include(`chosenProfit=${p.chosenProfit}, optimalProfit=${p.optimalProfit}`);
            for (const p of routeOvershoots) expect(report).to.include(`chosenProfit=${p.chosenProfit}, optimalProfit=${p.optimalProfit}`);
        }
    });
});
