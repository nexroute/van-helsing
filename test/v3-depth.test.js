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

// A walk for the pool a ward sinks into (dry): where crossing a tick leaves no liquidity, its depth
// is what the stretch before holds of the way to the target, in the sqrt price a restore is sized
// in, so a pool whose liquidity ends near its price reads as shallow as it is over the restore.
// Without it the walk averages only the stretch before the cliff, and a sink with a sliver of
// liquidity reads deep. Spacing 10, the price at tick 0 (sqrt 1), the target in compressed tick 10
// (or -10). Expectations from floats, close enough for these.
describe("V3Depth.effectiveLiquidity, dry (a sink's depth)", function () {
    let conn, harness;
    const L = 1000n * ONE;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        harness = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
    });

    const pool = async (spot, ticks) => {
        const mock = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, TOK0, TOK1]);
        for (const [t, net] of ticks) await mock.setTick(t, net);
        return mock.getAddress();
    };
    const both = async (addr, target) => [
        await harness.effectiveLiquidity(addr, target, 8),
        await harness.effectiveLiquidityDry(addr, target, 8),
    ];

    const near = (got, want) => expect(Math.abs(Number(got) / want - 1)).to.be.lt(1e-9);

    it("reads what the pool holds of the way to its target, walking up", async function () {
        // [-20, +20] holds L: token1 to the cliff is L * (sqrt(1.0001^20) - 1)
        const addr = await pool(L, [[-20, L], [20, -L]]);
        const target = sqrtAtTick(105);
        const [plain, dry] = await both(addr, target);
        expect(plain).to.equal(L);
        const t = Number(target) / 2 ** 96, edge = Math.sqrt(1.0001 ** 20);
        near(dry, (Number(L) * (edge - 1)) / (t - 1));
    });

    it("reads what the pool holds of the way to its target, walking down", async function () {
        // token0 to the cliff is L * (1 / sqrt(1.0001^-20) - 1)
        const addr = await pool(L, [[-20, L], [20, -L]]);
        const target = sqrtAtTick(-95);
        const [plain, dry] = await both(addr, target);
        expect(plain).to.equal(L);
        const t = Number(target) / 2 ** 96, edge = Math.sqrt(1.0001 ** -20);
        near(dry, (((Number(L) * (1 - edge)) / (1 - t)) * t) / edge);
    });

    // Any walk that runs dry keeps where in its record: the sqrt price, as TickMath has it, of the
    // tick whose crossing left no liquidity. One that never runs dry keeps none.
    it("keeps where it ran dry in its record, either way", async function () {
        const addr = await pool(L, [[-20, L], [20, -L]]);
        expect(await harness.cliffOf(addr, sqrtAtTick(105), 8)).to.equal(79307426338960776842885539845n); // tick 20
        expect(await harness.cliffOf(addr, sqrtAtTick(-95), 8)).to.equal(79148977909814923576066331265n); // tick -20
        const deep = await pool(L, [[-1000, L], [1000, -L]]);
        expect(await harness.cliffOf(deep, sqrtAtTick(105), 8)).to.equal(0n);
    });

    // Liquidity that comes back past a gap before the target, within the walk's steps: the pool is
    // two islands, and a sink crosses the gap into the second, so its walk keeps no cliff, either
    // way. A second island past the target leaves the first one's end a cliff.
    it("keeps no cliff where its liquidity comes back past a gap, either way", async function () {
        const up = await pool(L, [[-20, L], [20, -L], [40, L], [1000, -L]]);
        expect(await harness.cliffOf(up, sqrtAtTick(105), 8)).to.equal(0n);
        const down = await pool(L, [[-1000, L], [-40, -L], [-20, L], [20, -L]]);
        expect(await harness.cliffOf(down, sqrtAtTick(-95), 8)).to.equal(0n);
        const far = await pool(L, [[-20, L], [20, -L], [200, L], [1000, -L]]);
        expect(await harness.cliffOf(far, sqrtAtTick(105), 8)).to.equal(79307426338960776842885539845n); // tick 20
    });

    // The same when the walk runs dry on its last step: looking past the gap takes none of the
    // walk's steps. Up, eight positions end one spacing apart, so the walk runs dry crossing its
    // eighth tick; down, a word's end and seven positions do the same. On BNB Chain an anchor of
    // seven positions ran dry so, its deep second island went unseen, and the ward captured 40% of
    // what the deployed contract does.
    it("keeps no cliff where its liquidity comes back, though it ran dry on its last step", async function () {
        const stairsUp = [10, 20, 30, 40, 50, 60, 70, 80].map((t) => [t, -L / 8n]);
        const up = await pool(L, [[-20, L], ...stairsUp, [100, L], [1000, -L]]);
        expect(await harness.cliffOf(up, sqrtAtTick(205), 8)).to.equal(0n);
        const farUp = await pool(L, [[-20, L], ...stairsUp, [300, L], [1000, -L]]);
        expect(await harness.cliffOf(farUp, sqrtAtTick(205), 8)).to.not.equal(0n);
        const L7 = 700n * ONE;
        const stairsDown = [-10, -20, -30, -40, -50, -60, -70].map((t) => [t, L7 / 7n]);
        const down = await pool(L7, [[20, -L7], ...stairsDown, [-90, -L7], [-1000, L7]]);
        expect(await harness.cliffOf(down, sqrtAtTick(-195), 8)).to.equal(0n);
        const farDown = await pool(L7, [[20, -L7], ...stairsDown, [-300, -L7], [-1000, L7]]);
        expect(await harness.cliffOf(farDown, sqrtAtTick(-195), 8)).to.not.equal(0n);
    });

    // A price inside its tick, a hair under the cliff: the sliver is all the pool holds that way.
    it("reads a sliver under the cliff as the sliver it is", async function () {
        const mock = await deploy(conn, "MockV3TickPool", null, [79307426338960776842885539845n - 10n ** 18n, 19, L, 10, TOK0, TOK1]);
        await mock.setTick(-20, L);
        await mock.setTick(20, -L);
        const target = sqrtAtTick(105);
        const dry = await harness.effectiveLiquidityDry(await mock.getAddress(), target, 8);
        // the price is 1e18 under the cliff's sqrt price (TickMath at tick 20): differences in BigInt
        const edge = 79307426338960776842885539845n, cur = edge - 10n ** 18n;
        near(dry, (Number(L) * Number(edge - cur)) / Number(target - cur));
        expect(dry).to.be.lt(L / 1_000_000n);
    });

    it("reads as the plain walk when it never runs dry, either way", async function () {
        const addr = await pool(L, [[-1000, L], [1000, -L]]);
        for (const target of [sqrtAtTick(105), sqrtAtTick(-95)]) {
            const [plain, dry] = await both(addr, target);
            expect(plain).to.equal(L);
            expect(dry).to.equal(L);
        }
    });

    it("reads as the plain walk from a gap into liquidity, walking up", async function () {
        // no liquidity at the price; [+30, +1000] holds L: 3 wide at 0, then 7 at L
        const addr = await pool(0n, [[30, L], [1000, -L]]);
        const [plain, dry] = await both(addr, sqrtAtTick(105));
        expect(plain).to.equal((L * 7n) / 10n);
        expect(dry).to.equal((L * 7n) / 10n);
    });

    it("reads as the plain walk from a gap into liquidity, walking down", async function () {
        // no liquidity at the price; [-1000, -30] holds L: 3 wide at 0, then 7 at L
        const addr = await pool(0n, [[-1000, L], [-30, -L]]);
        const [plain, dry] = await both(addr, sqrtAtTick(-95));
        expect(plain).to.equal((L * 7n) / 10n);
        expect(dry).to.equal((L * 7n) / 10n);
    });
});
