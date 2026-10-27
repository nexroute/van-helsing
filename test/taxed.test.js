import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { v2Out, goldenMax, isqrt } from "./lib/pool-model.js";

// Pairs where one token takes a fee on transfer. A MockTaxToken T taxes transfers to and
// from the pools it is told to, like a launchpad token taxing its AMM pair; B is a plain
// token. Every case checks the outward invariants (ward never reverts, nothing is left in
// VanHelsing, the beneficiary never loses) and, where an arb exists, that the capture
// reaches the brute-force optimum of the taxed round trip: buy T at the cheap pool, lose
// the taxes in transit, sell it at the dear one.

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const LIBS = {
    libraries: {
        CurveLib: null, UniV4Lib: null, InfinityLib: null,
        V3Depth: null, V4Depth: null, RouteLib: null,
    },
};

// The registry's per-pool tax word: taxIn0 | taxOut0 | taxIn1 | taxOut1, 16 bits each,
// in basis points. In is VanHelsing -> pool, Out is pool -> VanHelsing.
function taxWord({ in0 = 0, out0 = 0, in1 = 0, out1 = 0 }) {
    return (BigInt(in0) << 48n) | (BigInt(out0) << 32n) | (BigInt(in1) << 16n) | BigInt(out1);
}

// What a MockTaxToken transfer of `amt` delivers when `bps` of it is taxed.
const net = (amt, bps) => amt - (amt * BigInt(bps)) / 10000n;

describe("VanHelsing on taxed tokens", function () {
    let conn, ethers, me;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
    });

    // A taxed token and a plain one, deployed until T lands on the requested side of the
    // address sort, so both token orders get exercised.
    async function tokens(tIsToken0) {
        for (;;) {
            const T = await deploy(conn, "MockTaxToken", null, ["Taxed", "TAX"]);
            const B = await deploy(conn, "MockERC20", null, ["Base", "BASE"]);
            const lo = (await T.getAddress()).toLowerCase() < (await B.getAddress()).toLowerCase();
            if (lo === tIsToken0) return { T, B };
        }
    }

    async function v2Pool(T, B, rT, rB) {
        const [t0, t1, r0, r1] = (await T.getAddress()).toLowerCase() < (await B.getAddress()).toLowerCase()
            ? [T, B, rT, rB] : [B, T, rB, rT];
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), 9975n, 10000n]);
        await t0.mint(me.address, r0); await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0); await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return { pool, kind: 0, fee: 25, id: idAddr(await pool.getAddress()) };
    }

    // A full-range V3 position holding the same virtual reserves a V2 pool of (rT, rB)
    // would, so its price and depth match.
    async function v3Pool(T, B, rT, rB, fee = 2500) {
        const tIs0 = (await T.getAddress()).toLowerCase() < (await B.getAddress()).toLowerCase();
        const [t0, t1, r0, r1] = tIs0 ? [T, B, rT, rB] : [B, T, rB, rT];
        const sqrtP = isqrt((r1 << 192n) / r0);
        const L = isqrt(r0 * r1);
        const pool = await deploy(conn, "MockV3SwapPool", null, [await t0.getAddress(), await t1.getAddress(), fee, sqrtP, 0, L]);
        await t0.mint(await pool.getAddress(), r0);
        await t1.mint(await pool.getAddress(), r1);
        return { pool, kind: 2, fee, id: idAddr(await pool.getAddress()) };
    }

    // Registry + VanHelsing with `def` ranked first and `alt` second, each registered
    // with the taxes its own transfers take: T's tax at that pool, on T's side.
    async function wire(T, B, def, alt, taxes) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], LIBS);
        const tIs0 = (await T.getAddress()).toLowerCase() < (await B.getAddress()).toLowerCase();
        const word = (t) => taxWord(tIs0 ? { in0: t.in, out0: t.out } : { in1: t.in, out1: t.out });
        await registry.setPools(await T.getAddress(), await B.getAddress(), [
            [def.id, def.kind, def.fee, word(taxes.def)],
            [alt.id, alt.kind, alt.fee, word(taxes.alt)],
        ]);
        return { registry, vh };
    }

    // The token tax each pool actually takes on T (what the registry states, unless a
    // case deliberately lies about it).
    async function taxPools(T, def, alt, taxes) {
        await T.setTax(await def.pool.getAddress(), taxes.def.out, taxes.def.in);
        await T.setTax(await alt.pool.getAddress(), taxes.alt.out, taxes.alt.in);
    }

    // Front-run the defended pool: swap `amt` of `token` into it straight through the
    // pair (pre-funded), so its price moves and the alt becomes the fair reference.
    async function frontRunV2(def, token, other, amt) {
        const pool = def.pool;
        const addr = await pool.getAddress();
        const tIn = (await token.getAddress()).toLowerCase();
        const t0 = (await pool.token0()).toLowerCase();
        const [r0, r1] = await pool.getReserves();
        await token.mint(me.address, amt);
        const before = await token.balanceOf(addr);
        await token.transfer(addr, amt);
        const got = (await token.balanceOf(addr)) - before;
        const zfo = tIn === t0;
        const out = zfo ? v2Out(got, r0, r1, 9975n, 10000n) : v2Out(got, r1, r0, 9975n, 10000n);
        await pool.swap(zfo ? 0n : out, zfo ? out : 0n, me.address, "0x");
    }

    async function balances(vh, T, B) {
        const v = await vh.getAddress();
        return {
            vhT: await T.balanceOf(v), vhB: await B.balanceOf(v),
            beneT: await T.balanceOf(BENEFICIARY), beneB: await B.balanceOf(BENEFICIARY),
        };
    }

    // Ward and assert the invariants; returns the beneficiary's gain in B and T.
    async function wardChecked(vh, id, T, B) {
        const pre = await balances(vh, T, B);
        await expect(vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 6_000_000 })).to.not.be.revert(ethers);
        const post = await balances(vh, T, B);
        expect(post.vhB, "B left in VanHelsing").to.equal(0n);
        expect(post.vhT, "T left in VanHelsing").to.equal(0n);
        expect(post.beneB >= pre.beneB, "beneficiary lost B").to.equal(true);
        expect(post.beneT >= pre.beneT, "beneficiary lost T").to.equal(true);
        return { b: post.beneB - pre.beneB, t: post.beneT - pre.beneT };
    }

    // V2 reserves of `p` as (T side, B side).
    async function v2Reserves(p, T) {
        const [r0, r1] = await p.pool.getReserves();
        return (await p.pool.token0()).toLowerCase() === (await T.getAddress()).toLowerCase() ? [r0, r1] : [r1, r0];
    }

    // Best B profit of buying T with `b` at `cheap` and selling it all at `dear`, both
    // V2, with T taxed `outCheap` leaving the cheap pool and `inDear` entering the dear one.
    function optimumV2(cheap, dear, outCheap, inDear) {
        const f = (b) => {
            const t = v2Out(b, cheap[1], cheap[0], 9975n, 10000n);
            const arrived = net(net(t, outCheap), inDear);
            return v2Out(arrived, dear[0], dear[1], 9975n, 10000n) - b;
        };
        return goldenMax(f, 1n, cheap[1]).y;
    }

    const CASES = [
        { name: "3% sell and buy tax at both pools", def: { in: 300, out: 300 }, alt: { in: 300, out: 300 } },
        { name: "1% sell tax at the defended pair only", def: { in: 100, out: 0 }, alt: { in: 0, out: 0 } },
        { name: "5% buy tax at the alt only", def: { in: 0, out: 0 }, alt: { in: 0, out: 500 } },
    ];

    for (const tIs0 of [true, false]) {
        for (const c of CASES) {
            for (const cheapAt of ["def", "alt"]) {
                it(`V2/V2, T is token${tIs0 ? 0 : 1}, ${c.name}, T cheap at the ${cheapAt}: captures the taxed optimum in B`, async function () {
                    const { T, B } = await tokens(tIs0);
                    const def = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
                    const alt = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
                    await taxPools(T, def, alt, c);
                    const { vh } = await wire(T, B, def, alt, c);
                    // T cheap at the defended pool: a front-run sold T into it. T dear
                    // there: a front-run bought T out of it with B.
                    if (cheapAt === "def") await frontRunV2(def, T, B, 15_000n * ONE);
                    else await frontRunV2(def, B, T, 150n * ONE);

                    const d = await v2Reserves(def, T), a = await v2Reserves(alt, T);
                    const [cheap, dear, cheapTax, dearTax] = cheapAt === "def" ? [d, a, c.def, c.alt] : [a, d, c.alt, c.def];
                    const best = optimumV2(cheap, dear, cheapTax.out, dearTax.in);
                    expect(best > 0n).to.equal(true);

                    const got = await wardChecked(vh, def.id, T, B);
                    expect(got.t, "profit paid in T").to.equal(0n);
                    expect(Number((got.b * 1_000_000n) / best) / 1e6, `captured ${got.b} of ${best}`).to.be.gte(0.9999);
                });
            }
        }
    }

    it("no-ops inside the fee plus tax wedge, even where the fees alone leave an arb", async function () {
        const { T, B } = await tokens(true);
        const def = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
        const alt = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
        const taxes = { def: { in: 500, out: 500 }, alt: { in: 500, out: 500 } };
        await taxPools(T, def, alt, taxes);
        const { vh } = await wire(T, B, def, alt, taxes);
        await frontRunV2(def, T, B, 3_000n * ONE); // ~6% price gap: past 0.5% of fees, inside ~10.5% with taxes
        const d = await v2Reserves(def, T), a = await v2Reserves(alt, T);
        expect(optimumV2(d, a, 0, 0) > 0n, "untaxed arb exists").to.equal(true);
        expect(optimumV2(d, a, 500, 500) <= 0n, "taxed arb does not").to.equal(true);
        const got = await wardChecked(vh, def.id, T, B);
        expect(got.b).to.equal(0n);
    });

    it("no-ops when both tokens are taxed", async function () {
        const T = await deploy(conn, "MockTaxToken", null, ["Taxed", "TAX"]);
        const U = await deploy(conn, "MockTaxToken", null, ["Taxed too", "TAX2"]);
        const def = await v2Pool(T, U, 100_000n * ONE, 1_000n * ONE);
        const alt = await v2Pool(T, U, 100_000n * ONE, 1_000n * ONE);
        for (const p of [def, alt]) {
            await T.setTax(await p.pool.getAddress(), 100, 100);
            await U.setTax(await p.pool.getAddress(), 100, 100);
        }
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], LIBS);
        const both = taxWord({ in0: 100, out0: 100, in1: 100, out1: 100 });
        await registry.setPools(await T.getAddress(), await U.getAddress(), [[def.id, 0, 25, both], [alt.id, 0, 25, both]]);
        await frontRunV2(def, T, U, 15_000n * ONE);
        const pre = [await T.balanceOf(BENEFICIARY), await U.balanceOf(BENEFICIARY)];
        await expect(vh["ward(bytes32,address)"](def.id, BENEFICIARY, { gasLimit: 6_000_000 })).to.not.be.revert(ethers);
        expect([await T.balanceOf(BENEFICIARY), await U.balanceOf(BENEFICIARY)]).to.deep.equal(pre);
    });

    // V3 legs: the mock checks its balance after the callback, so a taxed payment has to
    // be grossed up, and an exact-in sink has to ask for what will arrive. Its single
    // full-range position prices a swap exactly like a constant-product pool holding its
    // virtual reserves (L * 2^96 / sqrtP of token0, L * sqrtP / 2^96 of token1), and its
    // 0.25% fee matches the V2 pool's, so the same brute-force optimum applies.
    async function v3Reserves(p, T) {
        const [s] = await p.pool.slot0();
        const L = await p.pool.liquidity();
        const r0 = (L * (1n << 96n)) / s, r1 = (L * s) / (1n << 96n);
        return (await p.pool.token0()).toLowerCase() === (await T.getAddress()).toLowerCase() ? [r0, r1] : [r1, r0];
    }

    for (const tIs0 of [true, false]) {
        for (const cheapAt of ["def", "alt"]) {
            it(`V2 defended / V3 alt, T is token${tIs0 ? 0 : 1}, T taxed into and out of both, cheap at the ${cheapAt}`, async function () {
                const { T, B } = await tokens(tIs0);
                const def = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
                const alt = await v3Pool(T, B, 100_000n * ONE, 1_000n * ONE);
                const taxes = { def: { in: 300, out: 200 }, alt: { in: 100, out: 150 } };
                await taxPools(T, def, alt, taxes);
                const { vh } = await wire(T, B, def, alt, taxes);
                if (cheapAt === "def") await frontRunV2(def, T, B, 15_000n * ONE);
                else await frontRunV2(def, B, T, 150n * ONE);

                const d = await v2Reserves(def, T), a = await v3Reserves(alt, T);
                const [cheap, dear, cheapTax, dearTax] = cheapAt === "def" ? [d, a, taxes.def, taxes.alt] : [a, d, taxes.alt, taxes.def];
                const best = optimumV2(cheap, dear, cheapTax.out, dearTax.in);
                expect(best > 0n).to.equal(true);

                const got = await wardChecked(vh, def.id, T, B);
                expect(got.t).to.equal(0n);
                expect(Number((got.b * 1_000_000n) / best) / 1e6, `captured ${got.b} of ${best}`).to.be.gte(0.9999);
            });
        }
    }

    it("pays an untaxed V3 sink the exact amount, with no gross-up", async function () {
        const { T, B } = await tokens(true);
        const def = await v2Pool(T, B, 100_000n * ONE, 1_000n * ONE);
        const alt = await v3Pool(T, B, 100_000n * ONE, 1_000n * ONE);
        const taxes = { def: { in: 0, out: 0 }, alt: { in: 0, out: 0 } };
        const { vh } = await wire(T, B, def, alt, taxes);
        await frontRunV2(def, T, B, 15_000n * ONE);
        const got = await wardChecked(vh, def.id, T, B);
        expect(got.b + got.t > 0n).to.equal(true);
    });

    it("registry stores and returns each pool's tax word", async function () {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const a = "0x00000000000000000000000000000000000000a1";
        const b = "0x00000000000000000000000000000000000000b2";
        const id = idAddr("0x00000000000000000000000000000000000000c3");
        const word = taxWord({ in0: 1, out0: 2, in1: 3, out1: 4 });
        await registry.setPools(a, b, [[id, 0, 25, word]]);
        const e = await registry.entryOf(id);
        expect(e.tax).to.equal(word);
        expect(e.ok).to.equal(true);
        expect(e.fee).to.equal(25n);
    });
});
