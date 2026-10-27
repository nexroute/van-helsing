import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "./helpers/ids.js";

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";

function amtOut(inp, rIn, rOut, fn = 9975n, fd = 10000n) {
    return (inp * fn * rOut) / (rIn * fd + inp * fn);
}

describe("VanHelsing triangular routes (V2 trio)", function () {
    let conn, ethers, me;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
    });

    async function mkToken(sym) { return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]); }

    async function mkPool(x, y, rx, ry, feeNum = 9975n) {
        const ax = (await x.getAddress()).toLowerCase(), ay = (await y.getAddress()).toLowerCase();
        const [t0, t1, r0, r1] = ax < ay ? [x, y, rx, ry] : [y, x, ry, rx];
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), feeNum, 10000]);
        await t0.mint(me.address, r0); await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0); await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return pool;
    }

    // Build A (blue chip), X (longtail), B (blue chip bridge) with:
    //  defended P1 = (A, X), route hops (t0,B) and (B,t1) with (t0,t1)=sorted(A,X).
    // Skew P1 so X is cheap vs the route-implied price, giving a real arb.
    async function setup({ defReserves, priorities } = {}) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY],
            { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });

        const A = await mkToken("A"), X = await mkToken("X"), B = await mkToken("B");
        const aAddr = (await A.getAddress()).toLowerCase(), xAddr = (await X.getAddress()).toLowerCase();
        const [t0Tok, t1Tok] = aAddr < xAddr ? [A, X] : [X, A];

        // Fair: 1 A ~ 1 X. hops deep & balanced so the route price ~ 1. Defended skewed.
        const P1 = await mkPool(A, X, defReserves?.[0] ?? 1000n * ONE, defReserves?.[1] ?? 1000n * ONE);
        const hop1 = await mkPool(t0Tok, B, 100000n * ONE, 100000n * ONE); // (t0, B)
        const hop2 = await mkPool(B, t1Tok, 100000n * ONE, 100000n * ONE); // (B, t1)

        const p1Id = idAddr(await P1.getAddress());
        const h1 = idAddr(await hop1.getAddress()), h2 = idAddr(await hop2.getAddress());
        const routeId = idRoute(h1, h2);

        await registry.setPools(await t0Tok.getAddress(), await B.getAddress(), [[h1, 0, 25, 0]]);
        await registry.setPools(await B.getAddress(), await t1Tok.getAddress(), [[h2, 0, 25, 0]]);
        // defended pair (A,X): P1 first (defended), route second (the alt/sink)
        await registry.setPools(await A.getAddress(), await X.getAddress(), [[p1Id, 0, 25, 0], [routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(h1, h2, await B.getAddress()));

        if (priorities) for (const [tok, p, floor] of priorities) await registry.setToken(await tok.getAddress(), p, floor ?? 0n);

        return { registry, vh, A, X, B, P1, hop1, hop2, p1Id, routeId, t0Tok, t1Tok };
    }

    it("drives a dislocated V2 defended pool and sinks X -> B -> A", async function () {
        // Skew P1: dump X into it so X is cheap (needs restore by buying X / selling A).
        const s = await setup({ defReserves: [1000n * ONE, 4000n * ONE] }); // X over-supplied
        const { registry, vh, A, X, P1, p1Id } = s;

        const beneA = await A.balanceOf(BENEFICIARY);
        const beneX = await X.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](p1Id, BENEFICIARY, { gasLimit: 6_000_000 });

        const gain = (await A.balanceOf(BENEFICIARY)) - beneA + (await X.balanceOf(BENEFICIARY)) - beneX;
        expect(gain).to.be.gt(0n);
        // no residue on the contract
        expect(await A.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await X.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await s.B.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("captures within a few percent of the brute-force optimum", async function () {
        const s = await setup({ defReserves: [1000n * ONE, 4000n * ONE] });
        const { vh, A, X, P1, hop1, hop2, p1Id, t0Tok } = s;

        // Ternary search: profit(a) for driving `a` of the over-supplied token out of P1,
        // routing the received token through the two hops, repaying the driven input.
        // Direction: X is cheap, so restore buys X from P1 by selling A. The drive takes
        // X out first (flash), sinks X->B->A, repays A. profit in A = routeOutA - owedA.
        const [pr0, pr1] = await P1.getReserves();
        const p1t0 = (await P1.token0()).toLowerCase();
        const aAddr = (await A.getAddress()).toLowerCase();
        const [rA, rX] = p1t0 === aAddr ? [pr0, pr1] : [pr1, pr0];
        // The golden model needs the X->B and B->A hop reserves, found by token match.
        const bAddr = (await s.B.getAddress()).toLowerCase(), xAddr = (await X.getAddress()).toLowerCase();
        // reserves of `pool` oriented as (reserve of tokIn, reserve of the other token)
        async function reservesOf(pool, tokIn) {
            const [r0, r1] = await pool.getReserves();
            const t0 = (await pool.token0()).toLowerCase();
            return t0 === tokIn.toLowerCase() ? [r0, r1] : [r1, r0];
        }
        // find the hop that connects tokens u and v
        async function findPool(u, v) {
            for (const p of [hop1, hop2]) {
                const t0 = (await p.token0()).toLowerCase(), t1 = (await p.token1()).toLowerCase();
                if ((t0 === u && t1 === v) || (t0 === v && t1 === u)) return p;
            }
            throw new Error("no hop for " + u + "," + v);
        }
        const [rXin, rBout] = await reservesOf(await findPool(xAddr, bAddr), xAddr); // X -> B hop
        const [rBin, rAout] = await reservesOf(await findPool(bAddr, aAddr), bAddr); // B -> A hop

        // profit as a function of X taken out of P1 (a)
        function profit(a) {
            if (a <= 0n || a >= rX) return -1n;
            const owedA = (rA * a * 10000n) / ((rX - a) * 9975n) + 1n; // V2 amountIn to take `a` X out
            const b = amtOut(a, rXin, rBout);
            const outA = amtOut(b, rBin, rAout);
            return outA - owedA;
        }
        // ternary search
        let lo = 1n, hi = rX - 1n;
        for (let i = 0; i < 200; i++) {
            const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
            if (profit(m1) < profit(m2)) lo = m1; else hi = m2;
        }
        let best = 0n; for (const a of [lo, (lo + hi) / 2n, hi]) { const p = profit(a); if (p > best) best = p; }

        const beneA = await A.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        const got = (await A.balanceOf(BENEFICIARY)) - beneA;
        expect(got).to.be.gt(0n);
        // closed-form should reach >= 90% of the brute-force optimum
        expect(got * 100n >= best * 90n, `got ${got} vs best ${best}`).to.equal(true);
    });

    it("routes profit to the bridge token when it is the preferred blue chip", async function () {
        const s = await setup({ defReserves: [1000n * ONE, 4000n * ONE], priorities: [] });
        // prefer B (mid) over A/X so hop2 runs exact-out and profit lands in B
        await s.registry.setToken(await s.B.getAddress(), 100, 0n);
        const beneB = await s.B.balanceOf(BENEFICIARY);
        await s.vh["ward(bytes32,address)"](s.p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        expect((await s.B.balanceOf(BENEFICIARY)) - beneB).to.be.gt(0n);
        expect(await s.B.balanceOf(await s.vh.getAddress())).to.equal(0n);
    });

    it("captures the reverse dislocation (X expensive) with profit in the bridge", async function () {
        const s = await setup({ defReserves: [4000n * ONE, 1000n * ONE] }); // A over-supplied => X expensive
        await s.registry.setToken(await s.B.getAddress(), 100, 0n);
        const beneB = await s.B.balanceOf(BENEFICIARY);
        await s.vh["ward(bytes32,address)"](s.p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        expect((await s.B.balanceOf(BENEFICIARY)) - beneB).to.be.gt(0n);
        expect(await s.A.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.X.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.B.balanceOf(await s.vh.getAddress())).to.equal(0n);
    });

    it("no-ops (no revert) when a route hop was deregistered", async function () {
        const s = await setup({ defReserves: [1000n * ONE, 4000n * ONE] });
        // drop the (B, t1) hop by refreshing its pair to an empty list
        await s.registry.setPools(await s.B.getAddress(), await s.t1Tok.getAddress(), []);
        // ward must swallow the RouteLib revert (stale hop) and not strand funds
        await s.vh["ward(bytes32,address)"](s.p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        expect(await s.A.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.X.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.B.balanceOf(await s.vh.getAddress())).to.equal(0n);
    });

    it("no-ops (no revert) when the fees eat a route's whole spread", async function () {
        // Barely dislocated (0.1%): P1's fee plus both hop fees (~0.75% compounded)
        // eat the whole spread, so the fee check (MeetingPrice.noArb) stops the ward
        // before any flash, and the payout's floor check is never reached. The
        // BELOW_FLOOR test below needs a real profit to reach that require at all.
        const s = await setup({ defReserves: [1000n * ONE, 1001n * ONE] });
        const beneA = await s.A.balanceOf(BENEFICIARY);
        await s.vh["ward(bytes32,address)"](s.p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        expect(await s.A.balanceOf(BENEFICIARY)).to.equal(beneA); // unprofitable -> no payout
        expect(await s.A.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.X.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.B.balanceOf(await s.vh.getAddress())).to.equal(0n);
    });

    it("reverts BELOW_FLOOR when a genuinely profitable route can't clear the dust floor", async function () {
        // A real ~5% dislocation nets real profit (paid out in A here) after fees, so
        // unlike the barely-dislocated case above, the drive goes through and repays;
        // this is the only way to actually reach require(profit > floor, "BELOW_FLOOR")
        // in _drive for a ROUTE sink. Measure the realized profit with no floor set on a
        // baseline setup, then re-run the identical dislocation on a fresh (pristine
        // reserves) setup with the floor pinned one wei above it: the drive still
        // succeeds and repays, but the payout require now rejects it. execute() is
        // called directly (not ward()) so the revert reason survives: ward()'s
        // delegatecall swallows it.
        const baseline = await setup({ defReserves: [1000n * ONE, 1050n * ONE] });
        const beneABefore = await baseline.A.balanceOf(BENEFICIARY);
        await baseline.vh["ward(bytes32,address)"](baseline.p1Id, BENEFICIARY, { gasLimit: 6_000_000 });
        const profit = (await baseline.A.balanceOf(BENEFICIARY)) - beneABefore;
        expect(profit).to.be.gt(0n); // sanity: this dislocation is genuinely profitable

        const s = await setup({ defReserves: [1000n * ONE, 1050n * ONE] });
        await s.registry.setToken(await s.A.getAddress(), 0, profit + 1n);
        await expect(s.vh.execute(s.p1Id, BENEFICIARY, { gasLimit: 6_000_000 })).to.be.revertedWith("BELOW_FLOOR");

        // atomic revert -> nothing stranded
        expect(await s.A.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.X.balanceOf(await s.vh.getAddress())).to.equal(0n);
        expect(await s.B.balanceOf(await s.vh.getAddress())).to.equal(0n);
    });
});
