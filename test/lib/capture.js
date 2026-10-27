import { isqrt, sqrtPriceOf, liquidityOf, swapOut, profit, goldenMax, Q96, Q192, v3SwapToTarget, stableNormalizeModel } from "./pool-model.js";
import { deploy } from "../../lib/contract.js";

// TickMath sqrt-ratio bounds (matching VanHelsing/V3Lib), the extreme swap limits.
const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

// The drive amount (input) that moves a V2 defended pool to `targetSqrt`, the amount
// V2Lib.driveAmount works out in closed form: the input to reach a marginal price. Found by
// bisection on the resulting post-swap sqrt price (monotone in the input) rather than by
// solving the closed form directly: this is measurement code checking the shipped closed
// form against a real ward, not reimplementing it.
export function v2DriveAmount(m, targetSqrt, zeroForOne) {
    const rIn = zeroForOne ? m.r0 : m.r1;
    let lo = 0n, hi = rIn * 4n;
    for (let i = 0; i < 200 && hi - lo > 1n; i++) {
        const a = (lo + hi) / 2n;
        const outA = swapOut(m, a, zeroForOne);
        const nr0 = zeroForOne ? m.r0 + a : m.r0 - outA;
        const nr1 = zeroForOne ? m.r1 - outA : m.r1 + a;
        const s = isqrt((nr1 * Q192) / nr0);
        // price rises when !zeroForOne; drive toward target
        if ((s < targetSqrt) === zeroForOne) hi = a; else lo = a;
    }
    return (lo + hi) / 2n;
}

// VanHelsing can only ever flash a V2/concentrated leg (as _canDrive rules on-chain); a
// stableswap has no flash mode and is sink-only (CurveLib.sol). So normally the defended
// pool drives and the alt sinks, but when the defended itself is a stableswap, VanHelsing
// flips: the alt drives and the stableswap defended becomes the sink (_pickDriver/_restore).
// Every driver/sink-shaped computation below resolves through this so a stable leg works in
// either slot. Exported: the sweep applies this same rule to compute its own `dir` before
// calling captureFraction (see measure-sweep.test.js's computeDir), a read-only reuse, not a
// second implementation of the rule.
export function resolveDriver(defended, alt) {
    return defended.kind === "stable" ? { driver: alt, sink: defended } : { driver: defended, sink: alt };
}
// Only a flash-capable model can be driven (as _canDrive rules on-chain); resolveDriver
// never hands this a stableswap, but a caller building both legs as "stable" (no real
// on-chain driver exists then: _pickDriver itself would revert UNSUPPORTED) would
// otherwise fall through to concDriveAmount and crash on a model with no .ticks/.sqrtP.
// Throwing clearly here beats that obscure TypeError.
export function driveAmountFor(m, targetSqrt, zeroForOne) {
    if (m.kind === "v2") return v2DriveAmount(m, targetSqrt, zeroForOne);
    if (m.kind === "conc") return concDriveAmount(m, targetSqrt, zeroForOne);
    throw new Error(`driveAmountFor: kind "${m.kind}" cannot drive (see VanHelsing._canDrive)`);
}

// Meet-time capacity cap for a stableswap leg's linearized depth, the JS counterpart of
// CurveLib.depth's cap. The tangent L CurveLib.depth fits before its cap is honest near
// the peg but over-states what the pool can PAY once a restore pushes it toward
// saturation. The stable leg is always the sink and its price moves at most from its own
// live price sOwn to the other leg's sOther (MeetingPrice clamps each final into that
// interval), so cap L such that the LINEAR model's implied output over that whole
// interval cannot exceed HALF the output-side balance (rising price pays token0:
// amt0 = L*(sOther-sOwn)*Q96/(sOther*sOwn); falling pays token1:
// amt1 = L*(sOwn-sOther)/Q96). Nested floors match the contract's
// fullMulDiv(b0/2, fullMulDiv(sOther, sOwn, 1<<96), sOther-sOwn) exactly (BigInt
// division is an exact floor and cannot overflow). No-op for non-stable legs and
// for sOwn == sOther (meet no-ops there anyway).
//
// `cap` can itself floor to 0n (falling branch: `m.b1 / 2n` when the output-side
// balance is small relative to the interval; rising branch: the inner
// `(sOther * sOwn) / Q96` when the two prices' product undercuts Q96), which is
// reachable on a grotesque-but-registered pool, not something POOL_DUST rules
// out. A 0 cap is not "no capacity": fed into MeetingPrice.meet as `la == 0`, it
// reads as an infinitely deep sink (the tick-in-a-gap passthrough) and drives a
// full restore into a pool that can pay almost nothing, so the cap would invert
// its own purpose. Floor to 1 wei instead: a near-zero-capacity sink, so the
// sized drive rounds to ~0 and the ward dies at NO_ARB/BELOW_FLOOR instead of
// overshooting. Matches CurveLib.depth's `if (cap == 0) cap = 1` exactly.
export function capStableL(m, l, sOwn, sOther) {
    if (m.kind !== "stable" || sOwn === sOther) return l;
    let cap = sOther > sOwn
        ? ((m.b0 / 2n) * ((sOther * sOwn) / Q96)) / (sOther - sOwn)
        : ((m.b1 / 2n) * Q96) / (sOwn - sOther);
    if (cap === 0n) cap = 1n;
    return l < cap ? l : cap;
}

// Two-pass combine, DIRECTIONAL per leg: each leg takes the pass-1/pass-2 read that guards
// ITS OWN failure mode.
//   - driver (isDriver) keeps max(L1, L2), never re-walking the driver DOWN: a cliffy
//     driver's l2 > l1 recovers its core depth (the capture uplift), a barely-moving
//     driver's l2 << l1 keeps the deep long-walk read (avoids the far-target over-size);
//   - sink (!isDriver) keeps min(L1, L2): pass-2's shorter own-meet segment reveals LESS
//     absorbable depth, the conservative read against a sink over-absorbing.
// Not a symmetric mean: the geometric mean L1^.5*L2^.5, measured across weights, collapses
// a deep driver's re-walk into a thin active notch and over-sizes. A sink whose pass-2 read
// is zero sits in a gap of its liquidity, and keeps L1 (a zero depth would read as a pool to
// restore to in full). VanHelsing._pass2 applies the same rule.
export function twoPassCombine(L1, L2, isDriver) {
    return isDriver ? (L1 > L2 ? L1 : L2) : (L2 === 0n || L1 < L2 ? L1 : L2);
}

const MP_P = 1n << 64n;
// MeetingPrice.noArb in BigInt, exactly: the same floors, and x <= isqrt(wedge2) holds
// just when the contract's x*x <= wedge2 does
export function noArb(sd, nd, dd, sa, na, da) {
    const G = isqrt((dd * da * MP_P * MP_P) / (nd * na));
    const [lo, hi] = sd < sa ? [sd, sa] : [sa, sd];
    return (hi * MP_P) / lo <= G;
}

// VanHelsing's chosen drive size: normalize both legs to (s, L, fee), two-pass size each
// CONCENTRATED leg (walk toward the other pool's current price, mid-meet, re-walk at the
// leg's OWN pass-1 meeting price, DIRECTIONALLY combine: the driver keeps max, the sink
// keeps min, see twoPassCombine), cap a stable leg's L by its payable capacity over the
// restore interval (capStableL, pass-1 only: a stable leg is never re-walked), call the
// SHIPPED MeetingPrice.meet via the harness to get BOTH pools' final price, the driver met
// first as VanHelsing._finals meets it, then the drive amount that lands the actual driver
// (see resolveDriver) at its own final. `dir` is always
// the ACTUAL DRIVER's zeroForOne (whichever pool resolveDriver picks), not necessarily
// `defended`'s: callers compute it off the driver's own (current, final) pair. `h` =
// { mp } (MeetingPriceHarness), plus depth harnesses for concentrated legs and `curveLib`
// (CurveLibHarness) for a stable leg. Both the sweep's model-backed stable legs and the
// fork-backed stableNormalize legs flow through here, so the cap is applied in this one
// place.
export async function vanHelsingDriveSize(h, defended, alt, dir) {
    const dn = await legNormalize(h, defended), an = await legNormalize(h, alt);
    const [nd, dd] = feeND(defended), [na, da] = feeND(alt);
    if (noArb(dn.s, nd, dd, an.s, na, da)) return 0n; // the fee check: no-op drive, skip the walks
    // pass 1: walk each concentrated leg toward the OTHER pool's current price, cap a
    // stable leg (capStableL is a no-op for concentrated / V2 legs)
    let ld1 = dn.l ?? await concLegL(h, defended, an.s);
    let la1 = an.l ?? await concLegL(h, alt, dn.s);
    ld1 = capStableL(defended, ld1, dn.s, an.s);
    la1 = capStableL(alt, la1, an.s, dn.s);
    // resolveDriver is the same driver/sink split VanHelsing._meet uses (_canDrive(def.kind)).
    // The meeting price sinks its first pool's output in full into the second, so, as
    // VanHelsing._finals does, the driver goes first: an alt that drives is sized as such.
    const { driver } = resolveDriver(defended, alt);
    const defIsDriver = driver === defended;
    const finals = async (ld, la) => defIsDriver
        ? h.mp.meetBoth(dn.s, ld, nd, dd, an.s, la, na, da)
        : h.mp.meetBoth(an.s, la, na, da, dn.s, ld, nd, dd).then(([saF, sdF]) => [sdF, saF]);
    // pass-1 meet: each leg's own pass-1 meeting price (clamped between the two live prices)
    const [sdF1, saF1] = await finals(ld1, la1);
    // pass 2: re-walk each CONCENTRATED leg (dn.l == null) at its OWN pass-1 final and
    // combine DIRECTIONALLY: the driver keeps max(pass1, pass2), the sink keeps min;
    // V2/stable legs (dn.l != null) pass their pass-1 L through unchanged.
    const ld = dn.l == null ? twoPassCombine(ld1, await concLegL(h, defended, sdF1), defIsDriver) : ld1;
    const la = an.l == null ? twoPassCombine(la1, await concLegL(h, alt, saF1), !defIsDriver) : la1;
    // final meet -> the driver's own final -> drive size
    const [sdF, saF] = await finals(ld, la);
    return driveAmountFor(driver, defIsDriver ? sdF : saF, dir);
}

// Self-policing tolerance for the capture clamp below: a chosen profit materially above
// the golden search's optimum means goldenMax UNDER-FOUND the true max, and a silent
// Math.min(1, ...) clamp would then quietly inflate every capture number. The tolerance
// has two parts. Absolute: a few wei (integer-division plateaus and the search's final
// 3-point pick legitimately differ by a wei or two). Relative: 1e-12 of the optimum,
// because the profit curve's wei-scale sawtooth (every swap step floors its output and
// rounds its fee up) grows with pool depth (measured 21-47 wei at the sweep's L=1e28
// slice, i.e. ~1e-21 relative), so a purely absolute slop would mislabel that scale
// noise as under-finding. 1e-12 bounds the capture inflation the clamp could ever hide
// at 1e-12, eight orders below the 1e-4 resolution capture is even reported at, while a
// real optimizer regression (missing the max by any material fraction) still trips it.
// The sweep counts the flag and asserts it stays zero.
const OPT_SLOP_WEI = 4n;
const OPT_SLOP_DIV = 10n ** 12n;

// capture = chosenProfit/optimalProfit clamped into [0, 1] (see the READING section of the
// report measure-sweep.test.js writes, for the conventions). Shared by the direct and route
// paths so the clamp's self-policing (optimizerUnderFound) can never diverge between them.
function captureOf(chosenProfit, opt) {
    const slop = OPT_SLOP_WEI + (opt.y > 0n ? opt.y / OPT_SLOP_DIV : 0n);
    const optimizerUnderFound = opt.y > 0n && chosenProfit > opt.y + slop;
    if (optimizerUnderFound) {
        console.warn(`  [capture] goldenMax under-found the optimum: chosenProfit=${chosenProfit} exceeds optimalProfit=${opt.y} by ${chosenProfit - opt.y} wei (> ${slop} wei slop) at optimalSize=${opt.x}; the 100% clamp would silently hide this`);
    }
    const capture = opt.y <= 0n ? 1 : Math.min(1, Number((chosenProfit < 0n ? 0n : chosenProfit) * 10000n / opt.y) / 10000);
    return { capture, optimizerUnderFound };
}

// `dir`: the actual driver's zeroForOne (see vanHelsingDriveSize above).
export async function captureFraction(h, defended, alt, dir) {
    const chosen = await vanHelsingDriveSize(h, defended, alt, dir);
    const { driver, sink } = resolveDriver(defended, alt);
    const chosenProfit = profit(driver, sink, chosen, dir);
    // optimum over the whole drivable range. A V2 leg's range is bounded by its reserves;
    // a concentrated leg's by the input that drives it to the tick-price extreme.
    const hi = driveUpperBound(driver, dir);
    const opt = goldenMax((a) => profit(driver, sink, a, dir), 1n, hi);
    // "No arb in EITHER direction" must be MEASURED, not derived (the search above only
    // covers the chosen direction): when it finds no profitable size at all, also golden-
    // search the REVERSE drive and report its optimum, so the sweep report's no-arb claim
    // for both directions rests on two searches, not a symmetry argument. null when the
    // chosen direction had a real optimum (the reverse search is not run there).
    const optimalProfitReverse = opt.y <= 0n
        ? goldenMax((a) => profit(driver, sink, a, !dir), 1n, driveUpperBound(driver, !dir)).y
        : null;
    const overshoot = chosenProfit < 0n;
    const { capture, optimizerUnderFound } = captureOf(chosenProfit, opt);
    return { capture, chosenProfit, optimalProfit: opt.y, optimalProfitReverse, overshoot, chosen, optimalSize: opt.x, optimizerUnderFound };
}

// An upper bound on any profitable drive input, for the optimum search. V2: 4x the input
// reserve (as v2DriveAmount uses). Concentrated: the input that drives the pool all the
// way to the extreme tick price in `dir`, the whole modelled range, past which no more
// output is possible. `driver` is always flash-capable (V2/concentrated): resolveDriver
// never selects a stableswap here, since it can't drive. Exported; the route-aware capture
// below reuses it verbatim for a route's defended leg.
export function driveUpperBound(driver, dir) {
    if (driver.kind === "v2") return (dir ? driver.r0 : driver.r1) * 4n;
    const { amountIn } = v3SwapToTarget(driver, dir ? MIN_SQRT : MAX_SQRT, dir);
    return amountIn > 0n ? amountIn : 1n;
}

// Helpers filled per model. V2 legs need no depth harness.
//
// A leg's (sqrtPrice, effective liquidity). V2 and stable resolve both fields in one
// step: a stable leg's price AND depth come from the SAME CurveLibHarness.normalize call
// (see stableNormalize), so this fetches it once rather than once for price and again
// for L. A stableswap stays near peg while imbalanced, so the naive balances-ratio
// sqrtPriceOf would invent a phantom dislocation VanHelsing itself never sizes from.
// A concentrated leg's L additionally needs the OTHER leg's price to walk toward, so it
// comes back `l: null` here; the caller resolves it afterward via concLegL, once both
// legs' prices are known.
//
// A stable model with no `.real` (no on-chain or mock pool to read; the sweep is fork-free
// by design) falls back to stableNormalizeModel, a pure-JS port of CurveLib's price and
// uncapped depth, evaluated against the engine's own stableOut (calibrated against a live
// pool in measure-stable.test.js). A model with `.real` reads its pool on-chain.
//
// Exported: the sweep needs this same per-leg normalize to compute its own `dir` before
// calling captureFraction (see measure-sweep.test.js's computeDir).
export async function legNormalize(h, m) {
    if (m.kind === "stable") return m.real ? stableNormalize(h, m) : stableNormalizeModel(m);
    if (m.kind === "v2") return { s: sqrtPriceOf(m), l: liquidityOf(m) };
    return { s: sqrtPriceOf(m), l: null };
}
export function feeND(m) {
    if (m.kind === "v2" || m.kind === "stable") return [m.feeNum, m.feeDen];
    return concFeeND(m);
}
// Walked effective L for a concentrated leg, through the SHIPPED depth walk: exactly what
// VanHelsing sizes from (the walk toward `otherSqrt` within VanHelsing's budget of 8 steps,
// not spot L). Pass 1 walks toward the other pool's price, pass 2 toward the leg's own
// pass-1 meeting price. A real V4/Infinity leg (m.v4cfg set) reads via V4DepthHarness on
// its own config; a plain V3-shaped leg is materialized as a MockV3TickPool at the model's
// ticks and walked via V3DepthHarness. Both run the same walk; only the read source differs.
//
// `h.poolCache` (a Map), when supplied, memoizes the deployed MockV3TickPool by the
// model's shape (sqrtP/tick/spacing/spotL/ticks, NOT otherSqrt or fee, which don't affect
// the deployed pool). Optional: without it, `key` is falsy and every call deploys a fresh
// pool; the sweep, which revisits the same handful of shapes across thousands of grid
// points, opts in.
export async function concLegL(h, m, otherSqrt) {
    if (m.v4cfg) return BigInt(await h.v4depth.effectiveLiquidity(m.v4cfg, otherSqrt, 8n));
    const addr = await concPoolAddr(h, m);
    return BigInt(await h.v3depth.effectiveLiquidity(addr, otherSqrt, 8n));
}

async function concPoolAddr(h, m) {
    const key = h.poolCache && concCacheKey(m);
    if (key && h.poolCache.has(key)) return h.poolCache.get(key);
    const TOK0 = "0x0000000000000000000000000000000000000001";
    const TOK1 = "0x0000000000000000000000000000000000000002";
    const pool = await deploy(h.conn, "MockV3TickPool", null, [m.sqrtP, m.tick, m.spotL, m.spacing, TOK0, TOK1]);
    for (const t of m.ticks) await pool.setTick(t.tick, t.liqNet);
    const addr = await pool.getAddress();
    if (key) h.poolCache.set(key, addr);
    return addr;
}
function concCacheKey(m) {
    return `${m.sqrtP}|${m.tick}|${m.spacing}|${m.spotL}|` + m.ticks.map((t) => `${t.tick}:${t.liqNet}`).join(",");
}

function concFeeND(m) { return [m.feeNum, m.feeDen]; }

// A stable leg's normalized (s, L) via the SHIPPED CurveLib.price and CurveLib.depth
// (uncapped, at its own price), read through CurveLibHarness.normalize against `m.real`'s
// pool (a real fork pool, or a MockCurvePool the caller deployed), never approximated in
// pure JS. CurveLib.sol prices off a get_dy unit quote (A-aware: near-peg even while the
// balances are imbalanced) and depths off a get_dy price-impact fit; only the real (or
// mock) pool's own get_dy can produce either, so this is the one leg whose (s, L)
// genuinely has to come from the chain, not the model.
export async function stableNormalize(h, m) {
    if (!m.real) throw new Error("stableNormalize: model.real = { pool, t0, t1, curveKind } is required");
    const { pool, t0, t1, curveKind } = m.real;
    const [s, l] = await h.curveLib.normalize(curveKind, pool, t0, t1);
    return { s: BigInt(s), l: BigInt(l) };
}

// The drive input (fee-inclusive) that lands the pool exactly at `targetSqrt`, as
// VanHelsing's swap-to-limit drive does. Reuses the exact swap-to-target, so the input
// equals the `owed` the real drive repays and v3Out(input) reproduces its `got`.
export function concDriveAmount(m, targetSqrt, zeroForOne) {
    return v3SwapToTarget(m, targetSqrt, zeroForOne).amountIn;
}

// Route-aware capture (the ALT is a 2-hop route)
//
// A route is never the defended leg in the sweep (its route sub-grid only ever makes the
// ALT a route), so these functions run beside the direct path above, not through it.
// `route` bundles what RouteLib needs: `{ reg (the deployed PoolRegistry's address),
// routeId }`. Sizing goes through the SHIPPED RouteLib (via RouteLibHarness, `h.routeLib`),
// exactly as a direct concentrated leg goes through V3Depth (via `h.v3depth`), never a JS
// approximation of the composite. The composite virtual pool RouteLib composes is a SIZING
// tool only; VanHelsing always executes a route hop-by-hop, so the engine's route PROFIT
// (below) chains the two real hop models instead of swapping through the composite.

// Spot composite (sqrtPrice, fee) for a route, via RouteLib.normalize (maxTicks=0 inside:
// spot L, unused here; the walked L a drive actually sizes from comes from routeLegL once
// the defended's own price is known, the same `l: null` pattern concLegL follows for a
// direct concentrated leg).
export async function routeNormalize(h, route) {
    const [s, , fn, fd] = await h.routeLib.normalize(route.reg, route.routeId);
    return { s: BigInt(s), fn: BigInt(fn), fd: BigInt(fd) };
}

// Walked composite effective L toward `otherSqrt` (the defended's price), via RouteLib's
// own bounded walk (each concentrated hop walked toward a ratio-target, see RouteLib.sol).
export async function routeLegL(h, route, otherSqrt) {
    return BigInt(await h.routeLib.effectiveLiquidity(route.reg, route.routeId, otherSqrt, 8n));
}

// VanHelsing's chosen drive size when the ALT is a route. A route can never drive (only
// V2/concentrated can flash, resolveDriver's rule), so `defended` is always the driver
// here; `dir` is its own zeroForOne. Pass 1 only, unlike vanHelsingDriveSize: `ld` is
// walked once and never re-combined with a pass-2 re-walk. On-chain, `_meet` runs `_pass2`
// on BOTH legs: `_canWalk(ROUTE)` is false, so only the ROUTE side keeps its pass-1 L
// there; a concentrated DEFENDED (always the driver against a route, which can never
// flash) still gets the driver-max combine. So this cell (conc defended + route alt)
// diverges from the shipped contract, not only the ROUTE leg itself. Inert on the sweep's
// route sub-grid (every defended leg it builds is uniform-shaped, so a pass-2 re-walk would
// read the same L as pass-1 and max(l1,l2) changes nothing); on a cliff-shaped defended
// this function would under-drive relative to the real contract (never over-drive, by the
// same L-monotonicity `MeetingPrice.meet` relies on elsewhere), so the gap is
// conservative, not unsafe.
export async function vanHelsingRouteDriveSize(h, defended, route, dir) {
    const dn = await legNormalize(h, defended);
    const an = await routeNormalize(h, route);
    const ld = dn.l ?? await concLegL(h, defended, an.s);
    const la = await routeLegL(h, route, dn.s);
    const [nd, dd] = feeND(defended);
    const [sdF] = await h.mp.meetBoth(dn.s, ld, nd, dd, an.s, la, an.fn, an.fd);
    return driveAmountFor(defended, sdF, dir);
}

// The engine's route profit: drive `defended` for `driveIn`, then sink the output through
// the two REAL hop models in series (never the composite; see the note above). `dir1` is
// hop1's own t0->mid zeroForOne, `dir2` is hop2's own mid->t1 zeroForOne (both "near->far",
// see buildHopPool in measure-sweep.test.js).
//
// The physical order the sink chain runs in follows VanHelsing._sink / RouteLib.cxRoute
// exactly, and it depends on `dir`: got = defended's own output token, t1 when dir
// (zeroForOne) is true, t0 when false (RouteLib.cxRoute: `got = zeroForOne ? t1 : t0`).
// When got is t0 (dir false), the chain runs forward: hop1 (t0->mid) then hop2 (mid->t1).
// When got is t1 (dir true), RouteLib._hops swaps the execution order to (hop2, hop1) AND
// each leg runs its own reverse: hop2 as t1->mid (!dir2), then hop1 as mid->t0 (!dir1).
// Running hop1(dir1) then hop2(dir2) regardless of `dir` would score the WRONG chain for
// `dir=true`, which every route sub-grid point in the sweep hits (its defended leg is
// always built dislocated ABOVE the route's ~1:1 anchor), and the sweep would hardly show
// it: every route sub-grid pool is deep and close to 1:1, so forward vs. reverse barely
// moves the number for a tiny trade against deep, near-symmetric liquidity.
//
// A dry hop (mid <= 0) short-circuits to a flat loss of the whole drive input, as profit()
// in pool-model.js treats a dry direct sink.
export function routeProfit(defended, hop1, hop2, driveIn, dir, dir1, dir2) {
    if (driveIn <= 0n) return 0n;
    const got = swapOut(defended, driveIn, dir);
    if (got <= 0n) return 0n;
    const [firstHop, firstDir, secondHop, secondDir] = dir ? [hop2, !dir2, hop1, !dir1] : [hop1, dir1, hop2, dir2];
    const mid = swapOut(firstHop, got, firstDir);
    if (mid <= 0n) return -driveIn;
    const out = swapOut(secondHop, mid, secondDir);
    return out - driveIn;
}

// captureFraction's route counterpart: same shape and same capture/overshoot definition,
// sized via vanHelsingRouteDriveSize (the shipped RouteLib) and scored via routeProfit
// (the real per-hop chain).
export async function captureFractionRoute(h, defended, route, hop1, hop2, dir, dir1, dir2) {
    const chosen = await vanHelsingRouteDriveSize(h, defended, route, dir);
    const chosenProfit = routeProfit(defended, hop1, hop2, chosen, dir, dir1, dir2);
    const hi = driveUpperBound(defended, dir);
    const opt = goldenMax((a) => routeProfit(defended, hop1, hop2, a, dir, dir1, dir2), 1n, hi);
    // Reverse-direction search on a no-arb result: the same measured both-directions
    // contract as captureFraction above.
    const optimalProfitReverse = opt.y <= 0n
        ? goldenMax((a) => routeProfit(defended, hop1, hop2, a, !dir, dir1, dir2), 1n, driveUpperBound(defended, !dir)).y
        : null;
    const overshoot = chosenProfit < 0n;
    const { capture, optimizerUnderFound } = captureOf(chosenProfit, opt);
    return { capture, chosenProfit, optimalProfit: opt.y, optimalProfitReverse, overshoot, chosen, optimalSize: opt.x, optimizerUnderFound };
}
