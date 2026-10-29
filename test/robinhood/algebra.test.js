import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "../helpers/ids.js";
import { describeRobinhoodBuild } from "../helpers/fork.js";

// Algebra Integral pools (kind 3), in the Robinhood build, which trades them (Chain.ALGEBRA): no
// slot0 but globalState, whose third word is the fee the pool's plugin last set, and initialized
// ticks kept as a linked list. A ward trades them as V3 pools; it reads their price and live fee
// from globalState and walks their depth along the links (V3Depth.effectiveLiquidityList), over
// raw ticks. Mocks (MockAlgebraPool), no fork.

const ONE = 10n ** 18n;
const Q96 = 2n ** 96n;
const ALGEBRA = 3;
const MAX_U128 = 2n ** 128n - 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const PAYEE = "0x000000000000000000000000000000000000dEaD";
const LIBS = { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } };
// The sqrtPriceX96 of a tick, near enough for a target or a mock's price.
const sqrtAtTick = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
const TOK0 = "0x0000000000000000000000000000000000000001";
const TOK1 = "0x0000000000000000000000000000000000000002";

function isqrt(n) {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

describeRobinhoodBuild("VanHelsing and Algebra Integral pools", function () {
    let conn, ethers, me, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
        harness = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
    });

    describe("depth along the tick links", function () {
        // Every walk against a unit-by-unit model, as for V3 pools (test/v3-depth.test.js) at
        // spacing 1: the price at the bottom of its tick and the target at the bottom of its own,
        // each tick between counted once at the liquidity the price meets there, and the walk
        // ending where the liquidity runs out.
        it("gives the span-weighted mean of every tick it crosses, both ways, on random layouts", async function () {
            this.timeout(600_000);
            const rng = (seed) => {
                let x = BigInt(seed) | 1n;
                return (lo, hi) => {
                    x ^= x << 13n; x &= 2n ** 64n - 1n; x ^= x >> 7n; x ^= x << 17n; x &= 2n ** 64n - 1n;
                    return lo + Number(x % BigInt(hi - lo + 1));
                };
            };
            const r = rng(20261028);
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
                const tick = r(-20_000, 20_000);
                const l0 = BigInt(r(0, 1000)) * ONE;
                const pool = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(tick), tick, l0]);
                // initialized ticks near the price, dense in places, some running the liquidity dry
                const nets = new Map();
                for (let i = r(0, 20); i > 0; i--) {
                    const t = tick + r(-40, 40);
                    const net = r(0, 4) === 0 ? 0n : BigInt(r(-1000, 1000)) * ONE;
                    nets.set(t, (nets.get(t) ?? 0n) + net);
                }
                for (let t = tick - r(0, 6); t <= tick; t++) if (r(0, 1)) nets.set(t, (nets.get(t) ?? 0n) + BigInt(r(-50, 50)) * ONE);
                for (const [t, net] of nets) await pool.setTick(t, net);
                for (let pair = 0; pair < 6; pair++) {
                    let tc = tick + r(-60, 60);
                    if (tc === tick) tc += 1;
                    const eff = await harness.effectiveLiquidityList(await pool.getAddress(), sqrtAtTick(tc + 0.5), 255);
                    expect(eff).to.equal(model(tick, tc, l0, nets), `layout ${layout} (tick ${tick}) toward ${tc}`);
                    checked++;
                }
            }
            expect(checked).to.equal(96);
        });

        it("replays a nearer target from the record of a walk toward a farther one", async function () {
            const pool = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, 5n * ONE]);
            for (const [t, net] of [[3, 2n * ONE], [9, -4n * ONE], [17, 6n * ONE], [-5, ONE], [-12, -2n * ONE]]) await pool.setTick(t, net);
            for (const [far, near] of [[sqrtAtTick(30), sqrtAtTick(12)], [sqrtAtTick(-30), sqrtAtTick(-8)]]) {
                const [walked, fromRecord, covered] = await harness.replayedList(await pool.getAddress(), far, near, 8);
                expect(covered).to.equal(true);
                expect(fromRecord).to.equal(walked);
            }
        });

        // A walk for the pool a ward sinks into: [-20, +20] holds L, and its depth is what that
        // holds of the way to the target, in sqrt price (floats, close enough).
        it("a dry list walk reads what the pool holds of the way to its target", async function () {
            const L = 1000n * ONE;
            const pool = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, L]);
            await pool.setTick(-20, L);
            await pool.setTick(20, -L);
            const at = await pool.getAddress();
            const want = (target) => {
                const t = Number(target) / 2 ** 96;
                if (t > 1) { const e = Math.sqrt(1.0001 ** 20); return (Number(L) * (e - 1)) / (t - 1); }
                const e = Math.sqrt(1.0001 ** -20);
                return (((Number(L) * (1 - e)) / (1 - t)) * t) / e;
            };
            const near = (got, w) => expect(Math.abs(Number(got) / w - 1)).to.be.lt(1e-9);
            for (const target of [sqrtAtTick(100.5), sqrtAtTick(-99.5)]) {
                expect(await harness.effectiveLiquidityList(at, target, 8)).to.equal(L);
                near(await harness.effectiveLiquidityListDry(at, target, 8), want(target));
            }
            for (const [far, nearer] of [[sqrtAtTick(100.5), sqrtAtTick(50.5)], [sqrtAtTick(-99.5), sqrtAtTick(-49.5)]]) {
                const [walked, fromRecord, covered] = await harness.replayedListDry(at, far, nearer, 8);
                expect(covered).to.equal(true);
                expect(fromRecord).to.equal(walked);
                near(walked, want(nearer));
            }
        });

        // Liquidity that comes back at the list's next tick before the target: the pool is two
        // islands and a sink crosses the gap, so the walk keeps no cliff, either way, as the bitmap
        // walk keeps none. A second island past the target leaves the first one's end a cliff.
        it("keeps no cliff where its liquidity comes back past a gap, either way", async function () {
            const L = 1000n * ONE;
            const islands = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, L]);
            for (const [t, net] of [[-1000, L], [-40, -L], [-20, L], [20, -L], [40, L], [1000, -L]]) await islands.setTick(t, net);
            const at = await islands.getAddress();
            expect(await harness.cliffOfList(at, sqrtAtTick(100.5), 8)).to.equal(0n);
            expect(await harness.cliffOfList(at, sqrtAtTick(-99.5), 8)).to.equal(0n);
            const far = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, L]);
            for (const [t, net] of [[-20, L], [20, -L], [200, L], [1000, -L]]) await far.setTick(t, net);
            expect(await harness.cliffOfList(await far.getAddress(), sqrtAtTick(100.5), 8)).to.equal(79307426338960776842885539845n); // tick 20
        });

        // The same when the walk runs dry crossing its last tick: the list's next tick is read
        // already, and looking at it takes none of the walk's steps. Eight positions end two ticks
        // apart, either way, and the liquidity comes back past them before the target.
        it("keeps no cliff where its liquidity comes back, though it ran dry on its last step", async function () {
            const L = 800n * ONE;
            const up = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, L]);
            for (const [t, net] of [[-20, L], ...[2, 4, 6, 8, 10, 12, 14, 16].map((t) => [t, -L / 8n]), [30, L], [1000, -L]]) await up.setTick(t, net);
            expect(await harness.cliffOfList(await up.getAddress(), sqrtAtTick(100.5), 8)).to.equal(0n);
            const down = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, L]);
            for (const [t, net] of [[20, -L], ...[-2, -4, -6, -8, -10, -12, -14, -16].map((t) => [t, L / 8n]), [-30, -L], [-1000, L]]) await down.setTick(t, net);
            expect(await harness.cliffOfList(await down.getAddress(), sqrtAtTick(-99.5), 8)).to.equal(0n);
        });

        // MIN_TICK and MAX_TICK link to themselves: a walk that reaches either stops there.
        it("stops at the end of the list, whatever the target", async function () {
            const pool = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, 5n * ONE]);
            await pool.setTick(10, ONE);
            expect(await harness.effectiveLiquidityList(await pool.getAddress(), MAX_SQRT, 8)).to.be.gt(5n * ONE);
            expect(await harness.effectiveLiquidityList(await pool.getAddress(), 4295128740n, 8)).to.equal(5n * ONE);
        });

        // A bitmap walk spends a step on every word with no initialized tick; the links do not.
        it("reaches a deep range past a sparse stretch that a V3 walk's word steps do not", async function () {
            const thin = ONE, deep = 1000n * ONE;
            const algebra = await deploy(conn, "MockAlgebraPool", null, [TOK0, TOK1, 100, sqrtAtTick(0), 0, thin]);
            const v3 = await deploy(conn, "MockV3TickPool", null, [sqrtAtTick(0), 0, thin, 1, TOK0, TOK1]);
            for (const pool of [algebra, v3]) await pool.setTick(3000, deep - thin); // the deep range starts 3,000 ticks up
            const target = sqrtAtTick(3500);
            const byLinks = await harness.effectiveLiquidityList(await algebra.getAddress(), target, 8);
            const byWords = await harness.effectiveLiquidity(await v3.getAddress(), target, 8);
            expect(byLinks).to.be.gt(100n * ONE); // 500 of the 3,500 ticks are deep
            expect(byWords).to.equal(thin); // eight words, 2,048 ticks, all thin
        });
    });

    describe("wards", function () {
        async function tokens() {
            let [A, B] = [await deploy(conn, "MockERC20", null, ["A", "A"]), await deploy(conn, "MockERC20", null, ["B", "B"])];
            if ((await A.getAddress()).toLowerCase() > (await B.getAddress()).toLowerCase()) [A, B] = [B, A];
            return [A, B];
        }

        // An Algebra pool at a price of one, `l` deep, funded for its range.
        async function algebra(A, B, l, fee) {
            const pool = await deploy(conn, "MockAlgebraPool", null, [await A.getAddress(), await B.getAddress(), fee, Q96, 0, l]);
            await A.mint(await pool.getAddress(), l);
            await B.mint(await pool.getAddress(), l);
            return pool;
        }

        async function v2(A, B, r) {
            const pool = await deploy(conn, "MockV2Pool", null, [await A.getAddress(), await B.getAddress(), 9970n, 10000n]);
            await A.mint(me.address, r);
            await B.mint(me.address, r);
            await A.approve(await pool.getAddress(), r);
            await B.approve(await pool.getAddress(), r);
            await pool.initReserves(r, r);
            return pool;
        }

        // A front-run sells `amt` of A into the pool, through the poker (V3's swap, Algebra's
        // callback answered by its fallback), or straight into a V2 pair.
        async function sellA(A, pool, amt, isV2) {
            if (isV2) {
                const [r0, r1] = await pool.getReserves();
                await A.mint(await pool.getAddress(), amt);
                await pool.swap(0n, (amt * 997n * r1) / (r0 * 1000n + amt * 997n), me.address, "0x");
                return;
            }
            const poker = await deploy(conn, "PoolPoker");
            await A.mint(await poker.getAddress(), amt);
            await poker.poke(await pool.getAddress(), true, amt);
        }

        async function wired(A, B, list) {
            const registry = await deploy(conn, "PoolRegistryHarness");
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], LIBS);
            await registry.setPools(await A.getAddress(), await B.getAddress(), list);
            return { registry, vh };
        }

        function captured(vh, rc) {
            return rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
        }

        async function settled(vh, rc, anchorId, A, B) {
            const [ev] = captured(vh, rc);
            expect(ev, "a capture").to.not.equal(undefined);
            expect(ev.args.anchor).to.equal(anchorId);
            const token = await ethers.getContractAt("MockERC20", ev.args.token);
            expect(await token.balanceOf(TREASURY)).to.equal(ev.args.bounty / 10n);
            expect(await token.balanceOf(PAYEE)).to.equal(ev.args.bounty - ev.args.bounty / 10n);
            for (const t of [A, B]) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
            return ev;
        }

        // The Algebra pool's price over the V2 pair's, as a ratio scaled 1e6.
        async function gap(pool, pair) {
            const [s] = await pool.globalState();
            const [r0, r1] = await pair.getReserves();
            return (s * s * 1_000_000n * r0) / (Q96 * Q96 * r1);
        }

        it("wards a dislocated Algebra pool against a V2 pair, leaving it within the two fees", async function () {
            const [A, B] = await tokens();
            const pool = await algebra(A, B, 10_000n * ONE, 500);
            const pair = await v2(A, B, 50_000n * ONE);
            const { vh } = await wired(A, B, [[idAddr(await pair.getAddress()), 0, 30, 0], [idAddr(await pool.getAddress()), ALGEBRA, 500, 0]]);
            await sellA(A, pool, 300n * ONE, false); // about 6% under the pair
            expect(await gap(pool, pair)).to.be.lt(950_000n);

            const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
            await settled(vh, rc, idAddr(await pair.getAddress()), A, B);
            // what is left is inside 0.05% + 0.3% of fees
            expect(await gap(pool, pair)).to.be.within(996_400n, 1_000_000n);
        });

        it("wards a dislocated V2 pair against an Algebra pool", async function () {
            const [A, B] = await tokens();
            const pool = await algebra(A, B, 50_000n * ONE, 100);
            const pair = await v2(A, B, 1_000n * ONE);
            const { vh } = await wired(A, B, [[idAddr(await pool.getAddress()), ALGEBRA, 100, 0], [idAddr(await pair.getAddress()), 0, 30, 0]]);
            await sellA(A, pair, 30n * ONE, true);

            const rc = await (await vh["ward(bytes32,address)"](idAddr(await pair.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
            await settled(vh, rc, idAddr(await pool.getAddress()), A, B);
        });

        // The entry says 0.01%, the plugin says 0.3%: a gap of about 0.5% clears the first with
        // the pair's 0.3% but not the second, so the ward sizes with what the pool will charge.
        it("prices an Algebra pool at the fee its plugin set when that is above its entry's", async function () {
            const [A, B] = await tokens();
            const pool = await algebra(A, B, 10_000n * ONE, 3000);
            const pair = await v2(A, B, 50_000n * ONE);
            const { vh } = await wired(A, B, [[idAddr(await pair.getAddress()), 0, 30, 0], [idAddr(await pool.getAddress()), ALGEBRA, 100, 0]]);
            await sellA(A, pool, 25n * ONE, false); // about 0.5% under the pair
            await expect(vh.execute(idAddr(await pool.getAddress()), PAYEE)).to.be.revertedWith("NO_ARB");

            await pool.setFee(100);
            const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
            await settled(vh, rc, idAddr(await pair.getAddress()), A, B);
        });

        it("wards a V2 pair against a route whose first hop is an Algebra pool", async function () {
            const [A, B] = await tokens();
            const M = await deploy(conn, "MockERC20", null, ["M", "M"]);
            const sorted = async (x, y) => ((await x.getAddress()).toLowerCase() < (await y.getAddress()).toLowerCase() ? [x, y] : [y, x]);
            // hop 1 (A, M) on an Algebra pool, hop 2 (M, B) on a V2 pair, both at a price of one
            const [h0, h1] = await sorted(A, M);
            const hopA = await algebra(h0, h1, 100_000n * ONE, 100);
            const [k0, k1] = await sorted(M, B);
            const hopB = await v2(k0, k1, 100_000n * ONE);
            const pair = await v2(A, B, 1_000n * ONE);
            const registry = await deploy(conn, "PoolRegistryHarness");
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], LIBS);
            await registry.setPools(await A.getAddress(), await M.getAddress(), [[idAddr(await hopA.getAddress()), ALGEBRA, 100, 0]]);
            await registry.setPools(await M.getAddress(), await B.getAddress(), [[idAddr(await hopB.getAddress()), 0, 30, 0]]);
            // the route's hops in the pair's order: (A, M) first as A sorts before B
            const route = idRoute(idAddr(await hopA.getAddress()), idAddr(await hopB.getAddress()));
            await registry.setPools(await A.getAddress(), await B.getAddress(), [[route, ROUTE, 0, 0], [idAddr(await pair.getAddress()), 0, 30, 0]]);
            await registry.setConfig(route, configRoute(idAddr(await hopA.getAddress()), idAddr(await hopB.getAddress()), await M.getAddress()));
            await sellA(A, pair, 30n * ONE, true);

            const rc = await (await vh["ward(bytes32,address)"](idAddr(await pair.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
            await settled(vh, rc, route, A, B);
            expect(await M.balanceOf(await vh.getAddress())).to.equal(0n);
        });
    });
});
