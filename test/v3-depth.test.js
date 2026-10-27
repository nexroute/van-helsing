import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

// V3Depth.effectiveLiquidity walks from a pool's own price toward the other pool's
// price and returns the span-weighted-mean liquidity over that stretch, so the
// meeting-price sizing sees the depth the restore actually trades through, not the
// active tick alone. Two failure directions, both defense holes if mis-sized:
//   - thin active tick beside a DEEP range: spot reads shallow -> undersize ->
//     residual dislocation the attacker back-runs.
//   - deep active tick beside a CLIFF (liquidity drops one tick over): spot reads
//     deep -> oversize -> drive past what the other pool absorbs -> revert/overshoot.
// Both are pinned here. Uses mocks, no fork.

const Q96 = 2n ** 96n; // sqrtPriceX96 at tick 0 (price 1)
const ONE = 10n ** 18n;
const UP = Q96 * 2n; // any target above current price => walk up
const DOWN = Q96 / 2n; // any target below current price => walk down
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n; // TickMath.MAX_SQRT_RATIO
const MAX_U128 = 2n ** 128n - 1n;
// The sqrtPriceX96 of a tick, near enough for a target or a mock's price.
const sqrtAtTick = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
// MockV3TickPool's token0()/token1() are unused by V3Depth/V3DepthHarness (only
// RouteLib's per-hop sort reads them); any distinct placeholders are fine here.
const TOK0 = "0x0000000000000000000000000000000000000001";
const TOK1 = "0x0000000000000000000000000000000000000002";

describe("V3Depth.effectiveLiquidity (anti-sandwich sizing)", function () {
    let conn, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        harness = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
    });

    // thin active tick, deep neighbor above: the restore crosses the thin tick almost
    // immediately and runs in the deep range, so effective depth ~ the deep neighbor.
    it("sees a deep neighbor past a thin active tick (no undersize)", async function () {
        const spot = ONE;
        const deep = 1000n * ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        await mock.setTick(-10, spot); // thin position [-10,+10] enters here
        await mock.setTick(10, deep - spot); // thin exits (-1 ONE) + deep enters (+1000 ONE)
        await mock.setTick(1000, -deep); // deep position exits far above

        expect(await mock.liquidity()).to.equal(spot); // what a spot read would feed sizing
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), UP, 8);
        console.log(`  thin-active: spot=${spot} effective=${eff}`);
        expect(eff >= spot * 10n).to.equal(true);
    });

    // deep active tick, cliff above: liquidity drops an order of magnitude one tick
    // up, so effective depth must fall well below spot (else the drive oversizes).
    it("sees a cliff past a deep active tick (no oversize)", async function () {
        const spot = 1000n * ONE;
        const thin = ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        await mock.setTick(-10, spot); // deep position [-10,+10] enters here
        await mock.setTick(10, thin - spot); // deep exits (-1000 ONE) + thin enters (+1 ONE)
        await mock.setTick(1000, -thin); // thin position exits far above

        expect(await mock.liquidity()).to.equal(spot);
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), UP, 8);
        console.log(`  cliff: spot=${spot} effective=${eff}`);
        expect(eff <= spot / 10n).to.equal(true);
    });

    // symmetry: the same thin-active hole walking DOWN (deep neighbor below).
    it("sees a deep neighbor below when the restore lowers the price", async function () {
        const spot = ONE;
        const deep = 1000n * ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        // liquidityNet is the upward-crossing delta: deep position [-1000,-10] enters
        // at -1000, thin position [-10,+10] enters at -10 and exits at +10.
        await mock.setTick(-1000, deep); // deep enters (going up)
        await mock.setTick(-10, spot - deep); // deep exits + thin enters (going up)
        await mock.setTick(10, -spot); // thin exits (going up)

        expect(await mock.liquidity()).to.equal(spot);
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), DOWN, 8);
        console.log(`  thin-active-down: spot=${spot} effective=${eff}`);
        expect(eff >= spot * 10n).to.equal(true);
    });

    // the cliff walking DOWN: deep active tick, thin below. The deep near-run must
    // be counted, or the estimate collapses to thin and the drive oversizes downward.
    it("sees a cliff below a deep active tick (no oversize walking down)", async function () {
        const spot = 1000n * ONE;
        const thin = ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        // thin position [-1000,-10] enters at -1000, deep position [-10,+10] enters at
        // -10 (both as upward-crossing deltas).
        await mock.setTick(-1000, thin); // thin enters (going up)
        await mock.setTick(-10, spot - thin); // thin exits + deep enters (going up)
        await mock.setTick(10, -spot); // deep exits (going up)

        expect(await mock.liquidity()).to.equal(spot);
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), DOWN, 8);
        console.log(`  cliff-down: spot=${spot} effective=${eff}`);
        expect(eff <= spot / 10n).to.equal(true); // not read as deep
        expect(eff >= thin * 2n).to.equal(true); // the deep near-run is counted, not collapsed to thin
    });

    // current price at a deep negative tick (price << 1): exercises the signed
    // compressed-tick math and negative bitmap words, not just tick 0.
    it("walks correctly from a negative current tick", async function () {
        const spot = ONE;
        const deep = 1000n * ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96 / 4n, -6930, spot, 10, TOK0, TOK1]);
        await mock.setTick(-6940, spot); // thin position [-6940,-6920] enters
        await mock.setTick(-6920, deep - spot); // thin exits + deep enters
        await mock.setTick(-6900, -deep); // deep exits
        expect(await mock.liquidity()).to.equal(spot);
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), Q96, 8); // target above => up
        console.log(`  negative-tick: spot=${spot} effective=${eff}`);
        expect(eff >= spot * 10n).to.equal(true);
    });

    // an extreme target beyond all the pool's liquidity must not dilute the mean
    // with the empty tail: the walk stops at exhaustion, same result as a near target.
    it("stops at liquidity exhaustion regardless of how extreme the target is", async function () {
        const spot = ONE;
        const deep = 1000n * ONE;
        async function build() {
            const m = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
            await m.setTick(-10, spot);
            await m.setTick(10, deep - spot);
            await m.setTick(1000, -deep);
            return m.getAddress();
        }
        const near = await harness.effectiveLiquidity(await build(), Q96 * 2n, 8);
        const extreme = await harness.effectiveLiquidity(await build(), MAX_SQRT, 8);
        expect(extreme).to.equal(near); // a target past the liquidity is no different
        expect(extreme >= spot * 10n).to.equal(true);
    });

    // a malformed/extreme tick (net subtract exceeds live liquidity) must never
    // revert the walk: a revert here would silently no-op a ward. _applyDelta
    // saturates to zero and the walk stops.
    it("saturates instead of reverting when a tick would drive liquidity negative", async function () {
        const spot = ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        await mock.setTick(-10, spot);
        await mock.setTick(10, -(3n * ONE)); // subtract larger than live liquidity
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), Q96 * 2n, 8);
        expect(eff).to.equal(spot); // stopped after the first span, no revert
        expect(eff <= MAX_U128).to.equal(true);
    });

    // The walk measures each span from where the price stands: past its first step, at the
    // boundary it last crossed. Walking down, that boundary is one compressed tick above the
    // tick it searches from next, so every span after a crossing counts that tick too.
    it("counts every spacing walking down through initialized ticks one spacing apart", async function () {
        const thin = ONE;
        const deep = 1000n * ONE;
        // The price at tick 0, where a thin position [0,100) starts and a deep one [-1000,0) ends;
        // four 1-wei positions end at -10, -20, -30 and -40, one spacing apart.
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, thin, 10, TOK0, TOK1]);
        await mock.setTick(100, -thin);
        await mock.setTick(0, thin - deep);
        await mock.setTick(-1000, deep + 4n);
        for (const t of [-10, -20, -30, -40]) await mock.setTick(t, -1n);
        // Toward tick -50: every spacing between holds the deep position.
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), sqrtAtTick(-45), 8);
        expect(eff).to.be.closeTo(deep, 10n, "a downward walk reads the deep range it crosses");
    });

    // Every walk against a unit-by-unit model: the price at the bottom of its compressed tick and
    // the target at the bottom of its own, each spacing between counted once at the liquidity the
    // price meets there, and the walk ending where the liquidity runs out.
    it("gives the span-weighted mean of every spacing it crosses, both ways, on random layouts", async function () {
        this.timeout(600_000);
        const rng = (seed) => {
            let x = BigInt(seed) | 1n;
            return (lo, hi) => {
                x ^= x << 13n; x &= 2n ** 64n - 1n; x ^= x >> 7n; x ^= x << 17n; x &= 2n ** 64n - 1n;
                return lo + Number(x % BigInt(hi - lo + 1));
            };
        };
        const r = rng(20261027);
        // _applyDelta: saturate at 0 and at the top of uint128.
        const apply = (l, d) => (d < 0n ? (-d > l ? 0n : l + d) : (l + d > MAX_U128 ? MAX_U128 : l + d));
        const model = (pos, tc, l0, nets) => {
            let l = l0, wSum = 0n, tSum = 0n;
            if (tc > pos) {
                for (let u = pos; u < tc; u++) {
                    wSum += l; tSum += 1n;
                    if (nets.has(u + 1)) { l = apply(l, nets.get(u + 1)); if (l === 0n) break; }
                }
            } else {
                for (let u = pos - 1; u >= tc; u--) {
                    if (nets.has(u + 1)) { l = apply(l, -nets.get(u + 1)); if (l === 0n) break; }
                    wSum += l; tSum += 1n;
                }
            }
            return tSum === 0n ? l0 : wSum / tSum;
        };
        let checked = 0;
        for (let layout = 0; layout < 16; layout++) {
            const spacing = [10, 60, 200][r(0, 2)];
            const pos = r(-300, 300);
            const tick = pos * spacing + r(0, spacing - 1);
            const l0 = BigInt(r(0, 1000)) * ONE;
            const mock = await deploy(conn, "MockV3TickPool", null, [sqrtAtTick(tick), tick, l0, spacing, TOK0, TOK1]);
            // initialized ticks near the price, dense in places, some running the liquidity dry
            const nets = new Map();
            for (let i = r(0, 20); i > 0; i--) {
                const c = pos + r(-40, 40);
                const net = r(0, 4) === 0 ? 0n : BigInt(r(-1000, 1000)) * ONE;
                nets.set(c, (nets.get(c) ?? 0n) + net);
            }
            for (let c = pos - r(0, 6); c < pos; c++) if (r(0, 1)) nets.set(c, (nets.get(c) ?? 0n) + BigInt(r(-50, 50)) * ONE);
            for (const [c, net] of nets) await mock.setTick(c * spacing, net);
            for (let pair = 0; pair < 6; pair++) {
                let tc = pos + r(-60, 60);
                if (tc === pos) tc += 1;
                const target = sqrtAtTick(tc * spacing + spacing / 2);
                const eff = await harness.effectiveLiquidity(await mock.getAddress(), target, 255);
                expect(eff).to.equal(model(pos, tc, l0, nets), `layout ${layout} (spacing ${spacing}, pos ${pos}) toward ${tc}`);
                checked++;
            }
        }
        expect(checked).to.equal(96);
    });

    // a uniform pool with no initialized ticks in range keeps its spot liquidity.
    it("returns spot liquidity for a pool with no nearby ticks", async function () {
        const spot = 500n * ONE;
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        const eff = await harness.effectiveLiquidity(await mock.getAddress(), UP, 8);
        expect(eff).to.equal(spot);
    });
});
