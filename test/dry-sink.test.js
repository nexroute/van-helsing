import { network } from "hardhat";
import { expect } from "chai";
import { ethers } from "ethers";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "./helpers/ids.js";

// A ward sinks the warded pool's output into its anchor. An anchor whose liquidity ends near its
// price (a dust or one-sided pool) can absorb next to nothing past that point: sized as if it were
// deep, the ward drives the warded pool, the anchor pays out almost nothing, and repaying the drive
// fails with TransferFailed() after the whole drive. On BNB Chain these were 18k misses a day. The
// warded pool here is a constant-liquidity MockV3SwapPool; the anchor a CliffV3Pool, its only
// liquidity between two ticks. No fork.

const ONE = 10n ** 18n;
const L = 10n ** 21n;
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const PAYEE = "0x0000000000000000000000000000000000000B0b";
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };
const TRANSFER_FAILED = "0x90b8ec18";
// The sqrtPriceX96 of a tick, near enough for a price.
const sqrtAtTick = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;

// A [lower, upper] range as setup's options.
const bounds = ([lower, upper]) => ({ lower, upper });

// Why a call reverted: a require's reason, or a custom error's selector.
function reasonOf(e) {
    const data = e.data ?? e.info?.error?.data ?? "";
    if (typeof data === "string" && data.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
    return e.reason ?? (typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : e.shortMessage);
}

describe("VanHelsing against an anchor whose liquidity runs out", function () {
    let conn, ethers;

    // No fork: in the fork suite, a forked network would read the archive for each of the scans'
    // hundreds of fresh contracts.
    before(async function () {
        conn = await network.create({ network: "hardhat", override: process.env.VH_NO_FORK ? undefined : { forking: { enabled: false } } });
        ethers = conn.ethers;
    });

    // The warded pool at tick `def`, its anchor at tick `alt` holding L in [lower, upper], both 0.05%.
    // `exactOut` makes the token the drive puts out the pair's blue chip: the anchor then pays back
    // exactly what the drive owes, and the profit stays in that token.
    async function setup({ def, alt, lower, upper, altSqrt, spacing = 10, defL = L, exactOut = false }) {
        const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
        const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
        const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
        const [a0, a1] = [await t0.getAddress(), await t1.getAddress()];
        const warded = await deploy(conn, "MockV3SwapPool", null, [a0, a1, 500, sqrtAtTick(def), def, defL]);
        const anchor = await deploy(conn, "CliffV3Pool", null, [a0, a1, 500, spacing, altSqrt ?? sqrtAtTick(alt), L, lower, upper]);
        for (const pool of [warded, anchor]) {
            await t0.mint(await pool.getAddress(), 1000n * L);
            await t1.mint(await pool.getAddress(), 1000n * L);
        }
        const registry = await deploy(conn, "PoolRegistryHarness");
        await registry.setPools(a0, a1, [[idAddr(await anchor.getAddress()), 2, 500, 0], [idAddr(await warded.getAddress()), 2, 500, 0]]);
        if (exactOut) await registry.setToken(def > alt ? a1 : a0, 1n, 0n);
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], { libraries: LIBS });
        return { vh, id: idAddr(await warded.getAddress()), tokens: [t0, t1], registry };
    }

    // Nothing a ward touches stays in VanHelsing, whatever it did.
    async function holdsNothing(vh, tokens) {
        for (const t of tokens) expect(await t.balanceOf(await vh.getAddress()), "left in VanHelsing").to.equal(0n);
    }

    // What execute does: the bounty it captures, or why it reverts (a require's reason, or a custom
    // error's selector).
    async function outcome(vh, id) {
        try {
            const rc = await (await vh.execute(id, PAYEE, { gasLimit: 15_000_000 })).wait();
            const ev = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
            return { bounty: ev.args.bounty, gas: rc.gasUsed };
        } catch (e) {
            return { reason: reasonOf(e) };
        }
    }

    it("a sink whose liquidity ends just past its price does nothing instead of reverting after its drive", async function () {
        // The anchor holds L up to tick 10 only; the warded pool's price is 4% above it.
        const { vh, id, tokens } = await setup({ def: 400, alt: 0, lower: -600, upper: 10 });
        const out = await outcome(vh, id);
        await holdsNothing(vh, tokens);
        console.log(`      ${JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        expect(out.reason).to.not.equal(TRANSFER_FAILED);
        if (out.reason !== undefined) expect(["NO_ARB", "BELOW_FLOOR"]).to.include(out.reason);
    });

    it("a sink with no liquidity between its price and the other pool's does nothing", async function () {
        // The anchor's only liquidity is below its price, in [-600, -100]; the ward would push it up.
        const { vh, id } = await setup({ def: 400, alt: 0, lower: -600, upper: -100 });
        expect((await outcome(vh, id)).reason).to.equal("NO_ARB");
    });

    it("a sink sitting on its own lower tick, walked down, does nothing", async function () {
        // The anchor's price is exactly its range's lower tick; the warded pool's is 4% below it.
        const { vh, id } = await setup({ def: -400, alt: 0, lower: 0, upper: 600, altSqrt: 2n ** 96n });
        expect((await outcome(vh, id)).reason).to.equal("NO_ARB");
    });

    // A route is always a sink. Its first hop, a V3 pool between the pair's token0 and a bridge B,
    // holds liquidity one spacing either side of its price and none past; the second hop, B to
    // token1, is a deep V2 pair. The warded V2 pair is 10% off the route's price.
    it("a route with a hop that runs dry does nothing instead of reverting", async function () {
        const [me] = await ethers.getSigners();
        const tok = async (s) => deploy(conn, "MockERC20", null, [s, s]);
        const sorted = async (p, q) => (BigInt(await p.getAddress()) < BigInt(await q.getAddress()) ? [p, q] : [q, p]);
        const v2 = async (p, q, rp, rq) => {
            const [a, b] = await sorted(p, q);
            const [ra, rb] = a === p ? [rp, rq] : [rq, rp];
            const pool = await deploy(conn, "MockV2Pool", null, [await a.getAddress(), await b.getAddress(), 9975n, 10000]);
            await a.mint(me.address, ra); await b.mint(me.address, rb);
            await a.approve(await pool.getAddress(), ra); await b.approve(await pool.getAddress(), rb);
            await pool.initReserves(ra, rb);
            return pool;
        };
        const A = await tok("A"), X = await tok("X"), B = await tok("B");
        const [t0, t1] = await sorted(A, X);
        const warded = await v2(t0, t1, 1000n * ONE, 1100n * ONE);
        const [h0, h1] = await sorted(t0, B);
        const hop1 = await deploy(conn, "CliffV3Pool", null, [await h0.getAddress(), await h1.getAddress(), 500, 10, 2n ** 96n, L, -10, 10]);
        await h0.mint(await hop1.getAddress(), 1000n * L);
        await h1.mint(await hop1.getAddress(), 1000n * L);
        const hop2 = await v2(B, t1, 100000n * ONE, 100000n * ONE);
        const registry = await deploy(conn, "PoolRegistryHarness");
        const [i1, i2] = [idAddr(await hop1.getAddress()), idAddr(await hop2.getAddress())];
        const routeId = idRoute(i1, i2);
        await registry.setPools(await t0.getAddress(), await B.getAddress(), [[i1, 2, 500, 0]]);
        await registry.setPools(await B.getAddress(), await t1.getAddress(), [[i2, 0, 25, 0]]);
        await registry.setPools(await t0.getAddress(), await t1.getAddress(), [[idAddr(await warded.getAddress()), 0, 25, 0], [routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(i1, i2, await B.getAddress()));
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], { libraries: LIBS });
        const out = await outcome(vh, idAddr(await warded.getAddress()));
        await holdsNothing(vh, [t0, t1, B]);
        console.log(`      ${JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        expect(out.reason).to.not.equal(TRANSFER_FAILED);
        if (out.reason !== undefined) expect(["NO_ARB", "BELOW_FLOOR"]).to.include(out.reason);
    });

    // Spacing 100, the anchor's price a tenth into its tick, its liquidity ending at the tick's top,
    // the warded pool 20% above: the drive outruns the anchor, whose output still covers the debt.
    // Whatever the ward does, what the anchor could not take must not stay in VanHelsing.
    it("an exact-in sink stopped short leaves nothing behind", async function () {
        const { vh, id, tokens } = await setup({ def: 2000, alt: 10.5, lower: -1000, upper: 100, spacing: 100 });
        const out = await outcome(vh, id);
        console.log(`      ${JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        await holdsNothing(vh, tokens);
    });

    // An anchor whose liquidity ends at the edge of the tick its price sits in, wherever in that tick
    // the price is, the warded pool 4% to 49% away, above or below: the ward never takes more than
    // the anchor holds, whichever token it is paid in, so it captures or does nothing, and never
    // fails after its drive.
    it("an anchor priced anywhere inside its last tick is never overdrawn", async function () {
        const outcomes = [];
        for (const exactOut of [false, true])
            for (const side of [1, -1])
                for (const at of [10, 25, 50, 75, 90])
                    for (const def of [400, 1000, 2000, 4000]) {
                        const [lower, upper] = side > 0 ? [-1000, 100] : [-100, 1000];
                        const { vh, id, tokens } = await setup({ def: side * def, alt: side * (at + 0.5), lower, upper, spacing: 100, exactOut });
                        const out = await outcome(vh, id);
                        outcomes.push(`${exactOut ? "out" : "in"} ${side * def} ${at}%: ${out.reason ?? "captured"}`);
                        expect(out.reason, `exact ${exactOut ? "out" : "in"}, price ${at}% into its tick, warded pool ${side * def} ticks away`).to.not.be.oneOf([TRANSFER_FAILED, "SINK_SHORT"]);
                        await holdsNothing(vh, tokens);
                    }
        console.log(`      ${outcomes.join(", ")}`);
    });

    // A sink whose liquidity holds over the stretch a restore takes it through, and ends past it,
    // trades as if it had no cliff at all: the same bounty to the wei. Two shapes: a 4% gap between
    // equal pools with the cliff past the middle, and a warded pool 10,000x thinner than the sink and
    // 150x away in sqrt price against a sink whose only position reaches 2x past its price, as a
    // launchpad pool and its anchor on Robinhood Chain.
    it("a sink whose cliff lies past where the restore takes it captures as if it had none", async function () {
        for (const [def, upper, open, defL] of [[400, 300, 2000, L], [100000, 13860, 200000, L / 10000n]]) {
            const withCliff = await setup({ def, alt: 0, lower: -600, upper, defL });
            const cliff = await outcome(withCliff.vh, withCliff.id);
            await holdsNothing(withCliff.vh, withCliff.tokens);
            const without = await setup({ def, alt: 0, lower: -600, upper: open, defL });
            const none = await outcome(without.vh, without.id);
            console.log(`      warded at ${def}, cliff at ${upper}: ${cliff.bounty ?? cliff.reason}; no cliff: ${none.bounty ?? none.reason}`);
            expect(none.bounty).to.be.gt(0n);
            expect(cliff.bounty).to.equal(none.bounty);
        }
    });

    // Paid exactly what the drive owes, a sink trades only that much: a cliff short of where the
    // drive's whole output would take it, but past what it pays out, caps nothing. A warded pool
    // 10,000x thinner than the sink and 150x away in sqrt price, above it and below it, as a
    // launchpad pool and its anchor on Robinhood Chain when the profit is taken in USDG.
    it("an exact-out sink whose cliff lies past what it pays out captures as if it had none", async function () {
        for (const [def, cliffAt, openAt] of [[100000, 100, 200000], [-100000, -100, -200000]]) {
            const range = (edge) => (def > 0 ? [-600, edge] : [edge, 600]);
            const withCliff = await setup({ def, alt: 0, ...bounds(range(cliffAt)), defL: L / 10000n, exactOut: true });
            const cliff = await outcome(withCliff.vh, withCliff.id);
            await holdsNothing(withCliff.vh, withCliff.tokens);
            const without = await setup({ def, alt: 0, ...bounds(range(openAt)), defL: L / 10000n, exactOut: true });
            const none = await outcome(without.vh, without.id);
            console.log(`      warded at ${def}, cliff at ${cliffAt}: ${cliff.bounty ?? cliff.reason}; no cliff: ${none.bounty ?? none.reason}`);
            expect(none.bounty).to.be.gt(0n);
            expect(cliff.bounty).to.equal(none.bounty);
        }
    });

    it("a sink whose cliff lies past the meeting price still captures", async function () {
        // The meeting price is near the middle of the 4% gap: a cliff at tick 300 lies past it.
        const withCliff = await setup({ def: 400, alt: 0, lower: -600, upper: 300 });
        const cliff = await outcome(withCliff.vh, withCliff.id);
        await holdsNothing(withCliff.vh, withCliff.tokens);
        const without = await setup({ def: 400, alt: 0, lower: -600, upper: 2000 });
        const open = await outcome(without.vh, without.id);
        console.log(`      cliff at 300: ${cliff.bounty ?? cliff.reason}; no cliff: ${open.bounty ?? open.reason}; ratio ${cliff.bounty && open.bounty ? Number((cliff.bounty * 10000n) / open.bounty) / 10000 : "-"}`);
        expect(cliff.bounty).to.be.gt(0n);
        expect(open.bounty).to.be.gt(0n);
    });

    // A warded pool priced below its only liquidity, as a pool sold down past its lowest position,
    // against an anchor whose liquidity ends 20 ticks below its price. The drive first crosses a span
    // that holds nothing and trades nowhere there, so the cap reads the driver from where its
    // liquidity starts: the ward captures, where it reverted after its drive. Priced inside its
    // range, it captures what it did before, to the wei.
    it("a driver priced in a gap of its liquidity is capped where its liquidity starts", async function () {
        const gapped = async (defTick, defLower, exactOut) => {
            const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
            const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
            const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
            const [a0, a1] = [await t0.getAddress(), await t1.getAddress()];
            const warded = await deploy(conn, "CliffV3Pool", null, [a0, a1, 500, 10, sqrtAtTick(defTick), L, defLower, 2000]);
            const anchor = await deploy(conn, "CliffV3Pool", null, [a0, a1, 500, 10, sqrtAtTick(0), 10n * L, -20, 2000]);
            for (const pool of [warded, anchor]) {
                await t0.mint(await pool.getAddress(), 10n ** 30n);
                await t1.mint(await pool.getAddress(), 10n ** 30n);
            }
            const registry = await deploy(conn, "PoolRegistryHarness");
            await registry.setPools(a0, a1, [[idAddr(await anchor.getAddress()), 2, 500, 0], [idAddr(await warded.getAddress()), 2, 500, 0]]);
            if (exactOut) await registry.setToken(a0, 1n, 0n);
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], { libraries: LIBS });
            const out = await outcome(vh, idAddr(await warded.getAddress()));
            await holdsNothing(vh, [t0, t1]);
            return out;
        };
        const inside = { false: [276329426422165388n, 374464257637807381n], true: [281742107364924599n, 385674251948647405n] };
        for (const exactOut of [false, true]) {
            const pay = exactOut ? "exact out" : "exact in";
            for (const def of [-500, -405]) {
                const out = await gapped(def, -400, exactOut);
                console.log(`      ${pay}, priced at ${def} below its range from -400: ${out.bounty ?? out.reason}`);
                expect(out.bounty ?? 0n, `${pay}, priced at ${def}: ${out.reason}`).to.be.gt(0n);
            }
            expect((await gapped(-399, -400, exactOut)).bounty, `${pay}, inside from -400`).to.equal(inside[exactOut][0]);
            expect((await gapped(-500, -510, exactOut)).bounty, `${pay}, inside from -510`).to.equal(inside[exactOut][1]);
        }
    });

    // One VanHelsing and one registry for several pairs, so wards share transient storage.
    async function world() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], { libraries: LIBS });
        return { registry, vh };
    }

    // A pair on `registry`: a warded MockV3SwapPool at tick `def`, its anchor a CliffV3Pool at tick 0
    // holding L in [-2000, 2000].
    async function pair(registry, def) {
        const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
        const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
        const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
        const [a0, a1] = [await t0.getAddress(), await t1.getAddress()];
        const warded = await deploy(conn, "MockV3SwapPool", null, [a0, a1, 500, sqrtAtTick(def), def, L]);
        const anchor = await deploy(conn, "CliffV3Pool", null, [a0, a1, 500, 10, 2n ** 96n, L, -2000, 2000]);
        for (const p of [warded, anchor]) { await t0.mint(await p.getAddress(), 1000n * L); await t1.mint(await p.getAddress(), 1000n * L); }
        await registry.setPools(a0, a1, [[idAddr(await anchor.getAddress()), 2, 500, 0], [idAddr(await warded.getAddress()), 2, 500, 0]]);
        return { id: idAddr(await warded.getAddress()), tokens: [t0, t1] };
    }

    // A routed pair on `registry`: a V2 pair 10% off a route through a bridge B, whose first hop is
    // a CliffV3Pool holding L in [-2000, 2000] and whose second is a deep V2 pair.
    async function routed(registry) {
        const [me] = await ethers.getSigners();
        const tok = async (n) => deploy(conn, "MockERC20", null, [n, n]);
        const sorted = async (p, q) => (BigInt(await p.getAddress()) < BigInt(await q.getAddress()) ? [p, q] : [q, p]);
        const v2 = async (p, q, rp, rq) => {
            const [a, b] = await sorted(p, q);
            const [ra, rb] = a === p ? [rp, rq] : [rq, rp];
            const pool = await deploy(conn, "MockV2Pool", null, [await a.getAddress(), await b.getAddress(), 9975n, 10000]);
            await a.mint(me.address, ra); await b.mint(me.address, rb);
            await a.approve(await pool.getAddress(), ra); await b.approve(await pool.getAddress(), rb);
            await pool.initReserves(ra, rb);
            return pool;
        };
        const A = await tok("A"), X = await tok("X"), B = await tok("B");
        const [t0, t1] = await sorted(A, X);
        const warded = await v2(t0, t1, 1000n * ONE, 1100n * ONE);
        const [h0, h1] = await sorted(t0, B);
        const hop1 = await deploy(conn, "CliffV3Pool", null, [await h0.getAddress(), await h1.getAddress(), 500, 10, 2n ** 96n, L, -2000, 2000]);
        await h0.mint(await hop1.getAddress(), 1000n * L);
        await h1.mint(await hop1.getAddress(), 1000n * L);
        const hop2 = await v2(B, t1, 100000n * ONE, 100000n * ONE);
        const [i1, i2] = [idAddr(await hop1.getAddress()), idAddr(await hop2.getAddress())];
        const routeId = idRoute(i1, i2);
        await registry.setPools(await t0.getAddress(), await B.getAddress(), [[i1, 2, 500, 0]]);
        await registry.setPools(await B.getAddress(), await t1.getAddress(), [[i2, 0, 25, 0]]);
        await registry.setPools(await t0.getAddress(), await t1.getAddress(), [[idAddr(await warded.getAddress()), 0, 25, 0], [routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(i1, i2, await B.getAddress()));
        return { id: idAddr(await warded.getAddress()), tokens: [t0, t1, B] };
    }

    // Each ward's bounty when it runs alone, then when all run in one transaction, in order.
    async function aloneAndBatched(vh, ids) {
        const snap = await conn.networkHelpers.takeSnapshot();
        const alone = [];
        for (const id of ids) {
            alone.push((await outcome(vh, id)).bounty);
            await snap.restore();
        }
        const batch = await deploy(conn, "WardBatch");
        const rc = await (await batch.wards(await vh.getAddress(), ids, PAYEE, { gasLimit: 20_000_000 })).wait();
        const batched = {};
        for (const l of rc.logs) {
            try { const e = vh.interface.parseLog(l); if (e?.name === "Captured") batched[e.args.pool] = e.args.bounty; } catch { /* another contract's log */ }
        }
        return { alone, batched: ids.map((id) => batched[id]) };
    }

    // A ward reads the price limit of its own drive, never the one an earlier ward of the same
    // transaction left: one warded pool above its anchor, then one below.
    it("a ward before and a ward after in one transaction each set their own limit", async function () {
        const { registry, vh } = await world();
        const up = await pair(registry, 400), down = await pair(registry, -400);
        const { alone, batched } = await aloneAndBatched(vh, [up.id, down.id]);
        console.log(`      alone ${alone}, batched ${batched}`);
        expect(alone[0]).to.be.gt(0n);
        expect(alone[1]).to.be.gt(0n);
        expect(batched).to.deep.equal(alone);
        await holdsNothing(vh, [...up.tokens, ...down.tokens]);
    });

    // A route's hops keep the open limit: a direct ward's limit must not reach them.
    it("a direct ward then a route ward", async function () {
        const { registry, vh } = await world();
        const direct = await pair(registry, 400), route = await routed(registry);
        const { alone, batched } = await aloneAndBatched(vh, [direct.id, route.id]);
        console.log(`      alone ${alone}, batched ${batched}`);
        expect(alone[0]).to.be.gt(0n);
        expect(alone[1]).to.be.gt(0n);
        expect(batched).to.deep.equal(alone);
        await holdsNothing(vh, [...direct.tokens, ...route.tokens]);
    });
});
