// Pure-BigInt pool-model engine for VanHelsing capture measurement. No floats in money math.
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;

export function isqrt(n) {
    if (n < 0n) throw new Error("isqrt neg");
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
}

// V2 constant product (matches V2Lib exactly)
export function v2Out(amountIn, rIn, rOut, feeNum, feeDen) {
    return (amountIn * feeNum * rOut) / (rIn * feeDen + amountIn * feeNum);
}
export function v2In(amountOut, rIn, rOut, feeNum, feeDen) {
    return (rIn * amountOut * feeDen) / ((rOut - amountOut) * feeNum) + 1n;
}
export function v2Model(r0, r1, feeNum = 9975n, feeDen = 10000n) {
    return { kind: "v2", r0, r1, feeNum, feeDen };
}

export function sqrtPriceOf(m) {
    if (m.kind === "v2") return isqrt((m.r1 * Q192) / m.r0);
    if (m.kind === "conc") return m.sqrtP;
    if (m.kind === "stable") return isqrt((m.b1 * Q192) / m.b0);
    throw new Error("kind");
}
export function liquidityOf(m) {
    if (m.kind === "v2") return isqrt(m.r0 * m.r1);
    if (m.kind === "conc") return m.spotL;
    if (m.kind === "stable") return isqrt(m.b0 * m.b1);
    throw new Error("kind");
}

// swap `amountIn` through `model`; zeroForOne spends token0, receives token1.
export function swapOut(model, amountIn, zeroForOne) {
    if (model.kind === "v2") {
        const [rIn, rOut] = zeroForOne ? [model.r0, model.r1] : [model.r1, model.r0];
        return v2Out(amountIn, rIn, rOut, model.feeNum, model.feeDen);
    }
    if (model.kind === "conc") return v3Out(model, amountIn, zeroForOne);
    if (model.kind === "stable") return stableOut(model, amountIn, zeroForOne);
    throw new Error("kind");
}

// arb profit (in the drive-input token) for driving `defended` by `driveIn` in direction
// `dir` and sinking the output into `alt`, as VanHelsing does: drive out `got`, sink it for
// `out`, profit = out - driveIn.
export function profit(defended, alt, driveIn, dir) {
    if (driveIn <= 0n) return 0n;
    const got = swapOut(defended, driveIn, dir);
    if (got <= 0n) return 0n;
    const out = swapOut(alt, got, !dir);
    return out - driveIn;
}

// ternary search for the max of a unimodal fn over [lo, hi] (bigint domain).
export function goldenMax(fn, lo, hi) {
    for (let i = 0; i < 240 && hi - lo > 1n; i++) {
        const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
        if (fn(m1) < fn(m2)) lo = m1; else hi = m2;
    }
    let best = { x: lo, y: fn(lo) };
    for (const x of [lo, (lo + hi) / 2n, hi]) { const y = fn(x); if (y > best.y) best = { x, y }; }
    return best;
}

// Concentrated liquidity (V3/V4/Infinity): exact BigInt tick-by-tick swap
//
// These share the Uniswap concentrated-swap math, so one model represents every
// concentrated protocol for capture sizing (they also share the shipped depth walk
// and MeetingPrice.meet). Money math stays BigInt end to end.

// getAmount0/1 between two sqrt prices for liquidity L (a <= b). The output side
// floors (Uniswap rounds amountOut down); the *Up variants ceil for the input side
// (Uniswap rounds amountIn up), so a drive that stops at a target consumes at least
// what the real pool would.
function amt0(a, b, L) { if (a > b) [a, b] = [b, a]; return (L * (b - a) * Q96) / (b * a); }
function amt1(a, b, L) { if (a > b) [a, b] = [b, a]; return (L * (b - a)) / Q96; }
function amt0Up(a, b, L) { if (a > b) [a, b] = [b, a]; const n = L * (b - a) * Q96, d = b * a; return n / d + (n % d === 0n ? 0n : 1n); }
function amt1Up(a, b, L) { if (a > b) [a, b] = [b, a]; const n = L * (b - a); return n / Q96 + (n % Q96 === 0n ? 0n : 1n); }
// next sqrt price after adding amountIn: zeroForOne adds token0 (price down), else token1 (up).
function nextSqrt(sqrtP, L, amountIn, zeroForOne) {
    if (zeroForOne) return (L * Q96 * sqrtP) / (L * Q96 + amountIn * sqrtP); // add token0, price down
    return sqrtP + (amountIn * Q96) / L; // add token1, price up
}
function applyNet(L, net) { const r = L + net; return r < 0n ? 0n : r; }

// sqrtPriceX96 at a tick (1.0001^(tick/2) * 2^96). Ported TickMath.getSqrtRatioAtTick
// (Q128.128 mul chain, shifted to Q96 with round-up), verified exact at 0, +-1, and the
// MIN/MAX ticks.
export function sqrtAtTick(tick) {
    let absTick = tick < 0 ? BigInt(-tick) : BigInt(tick);
    let ratio = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
    const muls = [
        0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
        0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
        0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
        0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
        0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
        0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
    ];
    for (let i = 0; i < muls.length; i++) if ((absTick & (1n << BigInt(i + 1))) !== 0n) ratio = (ratio * muls[i]) >> 128n;
    if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
    // ratio is Q128.128; shift to Q96 (round up if any remainder), as TickMath does.
    return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

// A concentrated pool: current sqrtPrice/tick, tick spacing, its initialized ticks
// (sorted ascending, each {tick, liqNet}), the 1-fee multiplier over feeDen (1e6), and
// the spot active-tick liquidity. `v4cfg` (optional) marks a real V4/Infinity config so
// the walked L reads through V4Depth instead of a MockV3TickPool (see capture.concLegL).
export function concModel(sqrtP, tick, spacing, ticks, feeNum, feeDen, spotL, v4cfg = null) {
    return { kind: "conc", sqrtP, tick, spacing, ticks: ticks.slice().sort((p, q) => Number(p.tick - q.tick)), feeNum, feeDen, spotL, v4cfg };
}

// Exact tick-by-tick swap. amountIn of token0 (zeroForOne) or token1. Fee taken on the
// input, output floored: the Uniswap-V3 exact-in swap.
//
// Wei-scale note (this fn and v3SwapToTarget below): the engine matches the on-chain pool
// to a FEW WEI over a multi-tick drive, not bit-for-bit. v3SwapToTarget sums each crossed
// span's net (fee-free) amount and grosses the input up for the fee ONCE, globally; the
// real pool instead meters the fee PER STEP off the amount remaining at that step
// (SwapMath.computeSwapStep), so its nextSqrt/usedWithFee land on slightly different
// per-step roundings. Empirically that is 0-2 wei of divergence per crossed span, far
// under the 1% relative tolerance the fork calibration gates on, but it does mean a real
// multi-tick drive is not expected to be wei-exact (a single-span drive, no ticks crossed,
// is the case where the two fee schemes collapse to the same result).
export function v3Out(m, amountIn, zeroForOne) {
    let sqrtP = m.sqrtP, L = m.spotL, remaining = amountIn, out = 0n;
    const boundaries = m.ticks.slice().sort((p, q) => zeroForOne ? Number(q.tick - p.tick) : Number(p.tick - q.tick));
    for (const bd of boundaries) {
        if (remaining <= 0n || L <= 0n) break;
        const sqrtTarget = sqrtAtTick(bd.tick);
        if (zeroForOne ? sqrtTarget >= sqrtP : sqrtTarget <= sqrtP) continue; // behind us
        const inLessFee = (remaining * BigInt(m.feeNum)) / BigInt(m.feeDen);
        const maxIn = zeroForOne ? amt0Up(sqrtTarget, sqrtP, L) : amt1Up(sqrtP, sqrtTarget, L);
        let sqrtNext, usedLessFee;
        if (inLessFee >= maxIn) { sqrtNext = sqrtTarget; usedLessFee = maxIn; }
        else { sqrtNext = nextSqrt(sqrtP, L, inLessFee, zeroForOne); usedLessFee = inLessFee; }
        out += zeroForOne ? amt1(sqrtNext, sqrtP, L) : amt0(sqrtP, sqrtNext, L);
        const usedWithFee = (usedLessFee * BigInt(m.feeDen)) / BigInt(m.feeNum) + 1n;
        remaining -= usedWithFee > remaining ? remaining : usedWithFee;
        sqrtP = sqrtNext;
        if (sqrtNext === sqrtTarget) L = applyNet(L, zeroForOne ? -bd.liqNet : bd.liqNet);
        else break; // partial fill within the tick: done
    }
    if (remaining > 0n && L > 0n) {
        const inLessFee = (remaining * BigInt(m.feeNum)) / BigInt(m.feeDen);
        const sqrtNext = nextSqrt(sqrtP, L, inLessFee, zeroForOne);
        out += zeroForOne ? amt1(sqrtNext, sqrtP, L) : amt0(sqrtP, sqrtNext, L);
    }
    return out;
}

// Swap a concentrated pool to `targetSqrt` (the shipped swap-to-limit a drive uses),
// returning the fee-inclusive input consumed and the output produced. The input rounds
// up (as the pool's amountIn does), the output floors, so both the `owed` a drive
// repays and the `got` it sinks match the on-chain swap. `targetSqrt` must be on the
// walk side of the current price. Wei-scale divergence bound: see the note above v3Out;
// this is the fn that grosses the fee up once globally instead of metering it per step.
export function v3SwapToTarget(m, targetSqrt, zeroForOne) {
    let sqrtP = m.sqrtP, L = m.spotL, netIn = 0n, out = 0n;
    const boundaries = m.ticks.slice().sort((p, q) => zeroForOne ? Number(q.tick - p.tick) : Number(p.tick - q.tick));
    for (const bd of boundaries) {
        if (L <= 0n) break;
        if (zeroForOne ? sqrtP <= targetSqrt : sqrtP >= targetSqrt) break; // reached the target
        const st = sqrtAtTick(bd.tick);
        if (zeroForOne ? st >= sqrtP : st <= sqrtP) continue; // behind us
        // Stop at whichever comes first in the walk direction: the tick or the target.
        const reachTick = zeroForOne ? st >= targetSqrt : st <= targetSqrt;
        const end = reachTick ? st : targetSqrt;
        netIn += zeroForOne ? amt0Up(end, sqrtP, L) : amt1Up(sqrtP, end, L);
        out += zeroForOne ? amt1(end, sqrtP, L) : amt0(sqrtP, end, L);
        sqrtP = end;
        if (!reachTick) break; // stopped at the target inside this span
        L = applyNet(L, zeroForOne ? -bd.liqNet : bd.liqNet); // crossed the tick
    }
    // Finish within the last constant-L range if the target is still ahead.
    if ((zeroForOne ? sqrtP > targetSqrt : sqrtP < targetSqrt) && L > 0n) {
        netIn += zeroForOne ? amt0Up(targetSqrt, sqrtP, L) : amt1Up(sqrtP, targetSqrt, L);
        out += zeroForOne ? amt1(targetSqrt, sqrtP, L) : amt0(sqrtP, targetSqrt, L);
        sqrtP = targetSqrt;
    }
    const nn = BigInt(m.feeNum), dd = BigInt(m.feeDen);
    const amountIn = (netIn * dd) / nn + (netIn * dd % nn === 0n ? 0n : 1n); // gross-up the fee, round up
    return { amountIn, amountOut: out, sqrtAfter: sqrtP };
}

// Stableswap (Curve/PancakeStableSwap-style, 2-coin): exact BigInt get_dy
//
// VanHelsing never flash-drives a stableswap (CurveLib.sol: pre-funded exchange, no
// output-first mode), so this model is always the SINK side of a restore; capture.js
// resolves which of a (defended, alt) pair actually drives per its kind.
//
// D invariant and get_y, the classic 2-coin Curve StableSwap recurrence (no A_PRECISION
// scaling). `Ann` is `A * n` with n = 2. Which convention a real pool's own A() wants
// (raw A, or already A*n) is not assumed: it is calibrated wei-exact against a live
// PancakeStableSwap pool's get_dy in measure-stable.test.js; for that pool, `Ann = A() *
// 2` reproduces get_dy exactly across both directions and a wide range of trade sizes.
function stableD(x0, x1, Ann) {
    const S = x0 + x1;
    if (S === 0n) return 0n;
    let D = S;
    for (let k = 0; k < 255; k++) {
        const dp = (((D * D) / (x0 * 2n)) * D) / (x1 * 2n); // D^(n+1)/(n^n * prod(x))
        const prev = D;
        D = (((Ann * S) + dp * 2n) * D) / (((Ann - 1n) * D) + 3n * dp);
        if ((D > prev ? D - prev : prev - D) <= 1n) break;
    }
    return D;
}
// Solve for the output-coin balance y given the input-coin's new balance x. 2-coin: the
// other coin is the sole output, so (unlike an n>2 pool) no coin-index bookkeeping is
// needed to pick which balance is which here.
function stableY(x, Ann, D) {
    const c = (((D * D) / (x * 2n)) * D) / (Ann * 2n);
    const b = x + D / Ann;
    let y = D;
    for (let k = 0; k < 255; k++) {
        const prev = y;
        y = (y * y + c) / (2n * y + b - D);
        if ((y > prev ? y - prev : prev - y) <= 1n) break;
    }
    return y;
}

// `real`, when set, is { pool, t0, t1, curveKind }: the on-chain (or MockCurvePool) pool
// capture.js's stableNormalize reads the leg's (s, L) from, through CurveLib's price and
// depth, for a leg that must size through the shipped code rather than a pure-JS
// approximation.
export function stableModel(b0, b1, A, feeNum, feeDen, real = null) {
    return { kind: "stable", b0, b1, A, feeNum, feeDen, real };
}

// The exact 2-coin Curve get_dy: fee taken on the output the same way the real pool
// does (floor the fee portion first, then subtract), so this matches wei-exact, not
// just rate-equivalent.
export function stableOut(model, dx, zeroForOne) {
    if (dx <= 0n) return 0n;
    const { b0, b1, A, feeNum, feeDen } = model;
    // CurveLib.price's require(b0 > 0 && b1 > 0, "POOL_EMPTY"), plus A > 0 (both
    // stableD/stableY divide by Ann): a clear throw here beats a bare "Division by zero"
    // surfacing from deep inside the Newton iteration below.
    if (b0 <= 0n || b1 <= 0n || A <= 0n) throw new Error("stableOut: b0, b1, and A must all be positive");
    const [xIn0, xOut0] = zeroForOne ? [b0, b1] : [b1, b0];
    const Ann = A * 2n;
    const D = stableD(xIn0, xOut0, Ann);
    const y = stableY(xIn0 + dx, Ann, D);
    const dy = xOut0 - y - 1n;
    if (dy <= 0n) return 0n;
    return dy - (dy * (feeDen - feeNum)) / feeDen;
}

// Floor tick of a sqrt price (bisection over sqrtAtTick above), the same helper
// measure-conc.test.js and measure-stable.test.js keep local copies of.
export function tickAtSqrt(s) {
    let lo = -887272, hi = 887272;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sqrtAtTick(mid) <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// A pure-JS port of the (s, l) CurveLib.sol reads for a stableswap (price(), and depth()
// before its cap), for a stable model that has no real or mock on-chain pool to read: the
// sweep is fork-free by design, so a synthetic stable leg cannot go through the on-chain
// CurveLibHarness path capture.js's stableNormalize uses. Evaluated against THIS engine's
// own stableOut, which measure-stable.test.js calibrates wei-exact against a live
// PancakeStableSwap pool's get_dy, so feeding it the same get_dy-shaped quotes CurveLib.sol
// takes (a balance-scaled unit quote, min(1e18, b0/1000), for price, and a b0/100
// reference trade for the near-peg tangent depth fit) reproduces CurveLib's (s, l)
// exactly, without needing a live contract. The tangent's saturation over-statement is
// NOT corrected here: the capacity cap bounds it at meet time (capStableL in capture.js,
// CurveLib.depth's cap on-chain). Transcribed operation-for-operation from CurveLib.sol's
// price(), depth() and _depth() (BigInt division is already an exact floor, so no separate
// fullMulDiv port is needed; see that library's comments for the formulas).
const ONE18 = 10n ** 18n;
function stableModelDepth(m, refDx, s0) {
    if (refDx <= 0n) return 0n;
    const dy = stableOut(m, refDx, true);
    const s1 = ((dy * Q96) / refDx) * Q96 / s0;
    if (s1 === 0n || s1 >= s0) return 0n; // no measurable impact / wrong direction -> fallback
    return (dy * Q96) / (s0 - s1);
}
export function stableNormalizeModel(m) {
    if (m.b0 <= 0n || m.b1 <= 0n) throw new Error("stableNormalizeModel: POOL_EMPTY");
    // A balance-scaled unit quote: a fixed 1e18 probe reads phantom prices on pools
    // smaller than the probe. A pool too small to quote is refused outright.
    let dxU = m.b0 / 1000n; if (dxU > ONE18) dxU = ONE18;
    const dyU = dxU === 0n ? 0n : stableOut(m, dxU, true);
    if (dyU <= 0n) throw new Error("stableNormalizeModel: POOL_DUST");
    const s0 = isqrt((dyU * Q192) / dxU);
    // depth: the near-peg tangent fit (b0/100 reference trade). The unit-quote probe
    // (b0/1000, above) and this reference trade stay distinct at every pool size (the
    // trade is ten times the probe at least), so the impact the fit measures is never
    // the probe's own.
    let l = stableModelDepth(m, m.b0 / 100n, s0);
    if (l === 0n) l = isqrt(m.b0 * m.b1);
    return { s: s0, l };
}
