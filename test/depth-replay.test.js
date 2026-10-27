import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// Sizing's second pass walks each concentrated leg again, on the same state, toward its own
// meeting price: a nearer target than its first walk's, in the same direction. VanHelsing
// replays that walk from the first one's record (DepthRecord) instead of reading the pool again,
// so the replay must give exactly what the walk gives, whenever the record says it covers it,
// and must cover every walk toward a nearer target in the same direction that the record holds.

const Q96 = 2n ** 96n;
const TOK0 = "0x0000000000000000000000000000000000000001";
const TOK1 = "0x0000000000000000000000000000000000000002";
const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

// A deterministic generator, so a failure replays.
function rng(seed) {
    let x = BigInt(seed) | 1n;
    const next = () => {
        x ^= x << 13n; x &= 2n ** 64n - 1n;
        x ^= x >> 7n;
        x ^= x << 17n; x &= 2n ** 64n - 1n;
        return x;
    };
    return {
        int: (lo, hi) => lo + Number(next() % BigInt(hi - lo + 1)),
        big: (lo, hi) => lo + next() % (hi - lo + 1n),
        pick: (xs) => xs[Number(next() % BigInt(xs.length))],
    };
}

// The sqrtPriceX96 of a tick, near enough for a target.
const sqrtAt = (tick) => {
    const s = BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
    return s < MIN_SQRT ? MIN_SQRT : s > MAX_SQRT ? MAX_SQRT : s;
};

// A target between from and to: one of the ends, or a point between them.
const between = (r, from, to) => {
    const at = r.int(0, 9);
    if (at === 0) return from;
    if (at === 1) return to;
    const lo = from < to ? from : to;
    const hi = from < to ? to : from;
    return lo + r.big(0n, hi - lo);
};

// Every pair checks: covered => equal. A nearer target in the same direction, on a record that
// holds its walk (a budget of at most 8 steps, first target not the price itself), must be covered;
// on a flipped pool, but for a target at the pool's own price: cur is then the token-space price,
// which inverts back to the pool's own only up to rounding, so the record cannot vouch for the
// direction and the second walk is walked.
async function check(harness, args, cur, t1, t2, maxTicks, nearer, label, flipped = false) {
    const [walked, fromRecord, covered] = await harness.replayed(...args, t1, t2, maxTicks);
    if (covered) expect(fromRecord).to.equal(walked, `${label}: replayed ${fromRecord}, walked ${walked}`);
    if (nearer && maxTicks <= 8n && t1 !== cur && !(flipped && t2 === cur)) {
        expect(covered).to.equal(true, `${label}: not covered`);
    }
    return covered;
}

describe("DepthRecord: the second walk replayed from the first", function () {
    let conn, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        harness = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
    });

    it("gives what a V3 walk gives, on random tick layouts and targets", async function () {
        this.timeout(600_000);
        const r = rng(20261026);
        let checked = 0, covered = 0;
        for (let layout = 0; layout < 12; layout++) {
            const spacing = r.pick([1, 10, 60, 200]);
            const tick = r.int(-4000, 4000);
            const cur = sqrtAt(tick) + r.big(0n, 2n ** 60n);
            const spot = r.big(0n, 10n ** 24n);
            const pool = await deploy(conn, "MockV3TickPool", null, [cur, tick, spot, spacing, TOK0, TOK1]);
            // initialized ticks around the price, some taking the liquidity to nothing
            const n = r.int(0, 24);
            const near = Math.floor(tick / spacing);
            for (let i = 0; i < n; i++) {
                const t = (near + r.int(-40, 40)) * spacing;
                const net = r.int(0, 5) === 0 ? -spot : r.big(0n, 2n * 10n ** 24n) - 10n ** 24n;
                await pool.setTick(t, net);
            }
            for (let pair = 0; pair < 12; pair++) {
                const up = r.int(0, 1) === 1;
                const far = r.pick([1, 2, 5, 40, 400, 4000]);
                const t1 = sqrtAt(tick + (up ? far : -far) * spacing + r.int(-spacing, spacing));
                const maxTicks = BigInt(r.pick([8, 8, 8, 3, 1, 12]));
                const kind = r.int(0, 5);
                // nearer (most), beyond the first target, or the other way
                const t2 = kind < 4 ? between(r, cur, t1) : kind === 4 ? sqrtAt(tick + (up ? 2 : -2) * far * spacing) : sqrtAt(tick + (up ? -far : far) * spacing);
                if (await check(harness, [await pool.getAddress()], cur, t1, t2, maxTicks, kind < 4, `layout ${layout} pair ${pair}`)) covered++;
                checked++;
            }
        }
        console.log(`      ${checked} walks checked, ${covered} replayed`);
        expect(covered).to.be.gt(checked / 2);
    });
});

describeFork("DepthRecord on real pools (fork)", function () {
    const BLOCK = 103808000;
    const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const USDT = "0x55d398326f99059fF775485246999027B3197955";
    const NATIVE = "0x0000000000000000000000000000000000000000";
    const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849";
    const V4_DEEP = [4, USDT, WBNB, 500, 10, NATIVE, ZH];
    const INFI_NATIVE = [6, NATIVE, USDT, 67, 1, NATIVE, "0x0000000000000000000000000000000000000000000000000000000000010000"];
    let conn, v3, v4;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        v3 = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        v4 = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
    });

    // Targets in token space from a pool's own price p: up and down, a few ticks to a few percent.
    async function run(harness, args, cur, label, flipped = false) {
        const r = rng(label.length * 7919);
        let covered = 0;
        for (let pair = 0; pair < 24; pair++) {
            const up = pair % 2 === 0;
            const bps = BigInt(r.pick([1, 3, 10, 30, 100, 300, 1000]));
            const t1 = up ? cur + cur * bps / 20000n : cur - cur * bps / 20000n;
            if (await check(harness, args, cur, t1, between(r, cur, t1), 8n, true, `${label} pair ${pair}`, flipped)) covered++;
        }
        expect(covered).to.be.gt(12);
    }

    it("gives what a walk gives on Pancake V3 USDT/WBNB", async function () {
        const pool = new conn.ethers.Contract(V3_DEEP, ["function slot0() view returns (uint160)"], conn.ethers.provider);
        await run(v3, [V3_DEEP], await pool.slot0(), "v3");
    });

    it("gives what a walk gives on Uniswap V4 USDT/WBNB and on the flipped Infinity pool", async function () {
        const helper = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
        const [s4] = await helper.normalize(configV4(V4_DEEP));
        await run(v4, [configV4(V4_DEEP)], s4, "v4");
        const infi = await deploy(conn, "InfinityLibHarness", null, [], { libraries: { InfinityLib: null } });
        const [si] = await infi.normalize(configV4(INFI_NATIVE)); // token space: the walk inverts it
        await run(v4, [configV4(INFI_NATIVE)], si, "infinity", true);
    });
});
