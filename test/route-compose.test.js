import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "./helpers/ids.js";

const ONE = 10n ** 18n;
const Q192 = 1n << 192n;

// integer sqrt (bigint)
function isqrt(n) {
    if (n < 0n) throw new Error("neg");
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
}

describe("RouteLib.normalize (compose)", function () {
    let conn, ethers, me, registry, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
        registry = await deploy(conn, "PoolRegistryHarness");
        harness = await deploy(conn, "RouteLibHarness", null, [], { libraries: { V3Depth: null, V4Depth: null, RouteLib: null } });
    });

    async function mkToken(sym) { return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]); }

    // deploy a MockV2Pool for tokens (x,y) sorted, seed reserves matching x,y amounts.
    async function mkPool(x, y, rx, ry) {
        const [ax, ay] = [(await x.getAddress()).toLowerCase(), (await y.getAddress()).toLowerCase()];
        const [t0, t1, r0, r1] = ax < ay ? [x, y, rx, ry] : [y, x, ry, rx];
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), 9975, 10000]);
        await t0.mint(me.address, r0); await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0); await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return pool;
    }

    it("composes two V2 hops into the analytic virtual-reserve pool", async function () {
        // Tokens A, X (defended pair) and mid B. Route: X -> B -> A, i.e. pair (A,X) via B.
        const A = await mkToken("A"), X = await mkToken("X"), B = await mkToken("B");
        // hop1 connects (t0, mid); hop2 connects (mid, t1), where (t0,t1)=sorted(A,X).
        const aAddr = (await A.getAddress()).toLowerCase(), xAddr = (await X.getAddress()).toLowerCase();
        const [t0Tok, t1Tok] = aAddr < xAddr ? [A, X] : [X, A];

        // hop1 = (t0, B), hop2 = (B, t1). Pick asymmetric reserves so orientation matters.
        const hop1 = await mkPool(t0Tok, B, 500n * ONE, 800n * ONE); // (t0, B)
        const hop2 = await mkPool(B, t1Tok, 300n * ONE, 900n * ONE); // (B, t1)

        const h1 = idAddr(await hop1.getAddress());
        const h2 = idAddr(await hop2.getAddress());
        const routeId = idRoute(h1, h2);

        // register hops (own pairs) + the route (defended pair A/X)
        await registry.setPools(await t0Tok.getAddress(), await B.getAddress(), [[h1, 0, 25, 0]]);
        await registry.setPools(await B.getAddress(), await t1Tok.getAddress(), [[h2, 0, 25, 0]]);
        await registry.setPools(await A.getAddress(), await X.getAddress(), [[routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(h1, h2, await B.getAddress()));

        // analytic expectation (fee-free virtual reserves)
        const [h1r0, h1r1] = await hop1.getReserves(); // (t0side, Bside) since t0<B? depends; read tokens
        const h1t0 = (await hop1.token0()).toLowerCase();
        const t0Addr = (await t0Tok.getAddress()).toLowerCase();
        const A1 = h1t0 === t0Addr ? h1r0 : h1r1; // t0 reserve on hop1
        const M1 = h1t0 === t0Addr ? h1r1 : h1r0; // mid reserve on hop1
        const [h2r0, h2r1] = await hop2.getReserves();
        const bAddr = (await B.getAddress()).toLowerCase();
        const h2t0 = (await hop2.token0()).toLowerCase();
        const M2 = h2t0 === bAddr ? h2r0 : h2r1; // mid reserve on hop2
        const B2 = h2t0 === bAddr ? h2r1 : h2r0; // t1 reserve on hop2

        const den = M1 + M2;
        const V0 = (A1 * M2) / den;
        const V1 = (B2 * M1) / den;
        const sExp = isqrt((V1 * Q192) / V0);
        const lExp = isqrt(V0 * V1);

        const [s, l, fn, fd] = await harness.normalize(await registry.getAddress(), routeId);
        // within a handful of wei (floor rounding across two fullMulDivs + sqrt)
        expect(s >= sExp - 4n && s <= sExp + 4n, `s ${s} vs ${sExp}`).to.equal(true);
        expect(l >= lExp - 4n && l <= lExp + 4n, `l ${l} vs ${lExp}`).to.equal(true);
        expect(fn).to.equal(9975n * 9975n);
        expect(fd).to.equal(10000n * 10000n);
    });
});
