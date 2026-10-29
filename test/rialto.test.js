import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { v2Out } from "./lib/pool-model.js";

// A Rialto market as a ward's anchor: oracle-priced, its inventory in a vault, and a quote that is
// a step function of size (MockRialtoMarket). It cannot be flash-swapped, so it is always the sink:
// the AMM pool drives and the market absorbs. Its price and fee come from its own quotes at a
// reference size in each direction, a thousandth of what its vault holds of the input token, and
// a restore is capped so that the market never takes more than that: the half-spread only steps
// up with size, so the quote at the reference size is the worst price of any smaller trade. No fork.

const ONE = 10n ** 18n;
const Q96 = 2n ** 96n;
const RIALTO = 11;
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const PAYEE = "0x000000000000000000000000000000000000dEaD";
const LIBS = { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } };

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

describe("VanHelsing and a Rialto market", function () {
    let conn, ethers, me, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
        harness = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
    });

    async function tokens() {
        let [A, B] = [await deploy(conn, "MockERC20", null, ["A", "A"]), await deploy(conn, "MockERC20", null, ["B", "B"])];
        if ((await A.getAddress()).toLowerCase() > (await B.getAddress()).toLowerCase()) [A, B] = [B, A];
        return [A, B];
    }

    // A market at a mid of one B per A, quoting a half-spread of 10 bps up to `rung1` B of notional
    // and 50 bps up to 100,000 B, its vault holding 100,000 of each.
    async function market(A, B, rung1 = 5_000n * ONE) {
        const m = await deploy(conn, "MockRialtoMarket", null, [await A.getAddress(), await B.getAddress(), ONE]);
        await m.setRungs([rung1, 100_000n * ONE], [10n, 50n]);
        const vault = await m.traderVault();
        await A.mint(vault, 100_000n * ONE);
        await B.mint(vault, 100_000n * ONE);
        return m;
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

    // A front-run sells `amt` of A into the V2 pool, making A cheap there.
    async function frontRun(A, pool, amt) {
        const [r0, r1] = await pool.getReserves();
        await A.mint(await pool.getAddress(), amt);
        await pool.swap(0n, v2Out(amt, r0, r1, 9970n, 10000n), me.address, "0x");
    }

    async function warded(A, B, m, pool) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], LIBS);
        await registry.setPools(await A.getAddress(), await B.getAddress(), [[idAddr(await m.getAddress()), RIALTO, 0, 0], [idAddr(await pool.getAddress()), 0, 30, 0]]);
        return vh;
    }

    function captured(vh, rc) {
        return rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
    }

    it("prices a market from its own quotes: the mid, and its bid and ask as the fee", async function () {
        const [A, B] = await tokens();
        const m = await market(A, B);
        const [s, fn, fd] = await harness.marketPrice(RIALTO, await m.getAddress(), await A.getAddress(), await B.getAddress());
        // bid = mid (1 - 10 bps) and ask = mid / (1 - 10 bps): their geometric mean is the mid
        expect(s).to.be.closeTo(Q96, Q96 / 10n ** 12n);
        // and sqrt(bid / ask), the multiplier that makes mid x it the bid and mid / it the ask, is 1 - 10 bps
        expect(fn * 10_000n / fd).to.be.within(9_989n, 9_990n);
        expect(fn).to.be.lte(fd);
    });

    it("caps a market's depth so that a restore takes no more than its reference size, nor half its vault", async function () {
        const [A, B] = await tokens();
        const m = await market(A, B);
        const sOwn = Q96, sOther = Q96 * 101n / 100n; // the market's price rises 1%: it takes B in
        const l = await harness.depth(RIALTO, await m.getAddress(), await A.getAddress(), await B.getAddress(), sOwn, sOther);
        // B in over the whole move, for this L, is the reference size, 100 B (100,000 / 1,000)
        const bIn = l * (sOther - sOwn) / Q96;
        expect(bIn).to.be.closeTo(100n * ONE, ONE / 1000n);
        const down = await harness.depth(RIALTO, await m.getAddress(), await A.getAddress(), await B.getAddress(), sOwn, sOwn * 99n / 100n);
        const aIn = down * Q96 * (sOwn - sOwn * 99n / 100n) / (sOwn * (sOwn * 99n / 100n));
        expect(aIn).to.be.closeTo(100n * ONE, ONE / 1000n);
    });

    it("wards a dislocated pool against the market, paying the payee and the treasury, and leaves no allowance", async function () {
        const [A, B] = await tokens();
        const m = await market(A, B);
        const pool = await v2(A, B, 1_000n * ONE);
        const vh = await warded(A, B, m, pool);
        await frontRun(A, pool, 30n * ONE);

        const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
        const [ev] = captured(vh, rc);
        expect(ev, "a capture").to.not.equal(undefined);
        expect(ev.args.anchor).to.equal(idAddr(await m.getAddress()));
        expect(ev.args.bounty).to.be.gt(0n);
        const token = await ethers.getContractAt("MockERC20", ev.args.token);
        expect(await token.balanceOf(TREASURY)).to.equal(ev.args.bounty / 10n);
        expect(await token.balanceOf(PAYEE)).to.equal(ev.args.bounty - ev.args.bounty / 10n);
        for (const t of [A, B]) {
            expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
            expect(await t.allowance(await vh.getAddress(), await m.getAddress())).to.equal(0n);
        }
    });

    it("never sells the market more than its reference size, so a rung it would cross costs no loss", async function () {
        const [A, B] = await tokens();
        // a 10 bps rung up to 50 B only: the reference size, 100, quotes in the 50 bps rung, which
        // prices every smaller trade at least as well
        const m = await market(A, B, 50n * ONE);
        const pool = await v2(A, B, 10_000n * ONE);
        const vh = await warded(A, B, m, pool);
        await frontRun(A, pool, 3_000n * ONE); // a dislocation far wider than 100 A of restore

        const vault = await m.traderVault();
        const before = await A.balanceOf(vault);
        const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
        expect(captured(vh, rc)).to.have.length(1);
        const sold = (await A.balanceOf(vault)) - before;
        expect(sold).to.be.gt(0n);
        expect(sold).to.be.lte(100n * ONE);
    });

    it("does nothing, and does not revert, when the market refuses to quote", async function () {
        const [A, B] = await tokens();
        const m = await market(A, B);
        const pool = await v2(A, B, 1_000n * ONE);
        const vh = await warded(A, B, m, pool);
        await frontRun(A, pool, 30n * ONE);
        await m.setRefuse(true);

        const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
        expect(captured(vh, rc)).to.have.length(0);
        await expect(vh.execute(idAddr(await pool.getAddress()), PAYEE)).to.be.revertedWith("REFUSED");
    });

    it("does nothing when the pool is within the market's spread and its own fee", async function () {
        const [A, B] = await tokens();
        const m = await market(A, B);
        const pool = await v2(A, B, 1_000n * ONE);
        const vh = await warded(A, B, m, pool);
        await frontRun(A, pool, ONE / 10n); // 0.01% off: inside 10 bps + 0.3%

        await expect(vh.execute(idAddr(await pool.getAddress()), PAYEE)).to.be.revertedWith("NO_ARB");
    });
});
