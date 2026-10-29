import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../../lib/contract.js";
import { idAddr } from "../helpers/ids.js";
import { v2Out } from "../lib/pool-model.js";
import { describeRobinhoodBuild } from "../helpers/fork.js";

// Tessera as a ward's anchor, in the Robinhood build: one entry that prices every pair, paying out
// of one treasury, the address its Chain.sol names (MockTessera, its treasury placed there). Like
// a Rialto market it is priced by its own quotes at a reference size, a thousandth of what the
// treasury holds of the input token, and a restore into it is capped at that size. Its registry id
// is per pair: the entry's address in the low 160 bits, a tag of the pair above. No fork.

const ONE = 10n ** 18n;
const Q96 = 2n ** 96n;
const TESSERA = 25;
const TREASURY = "0x907d1D174569b11624bdcEfD20dcEF27600237f8";
const ADMIN = "0x00000000000000000000000000000000beC0ffEE";
const PAYEE = "0x000000000000000000000000000000000000dEaD";
const LIBS = { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } };

describeRobinhoodBuild("VanHelsing and Tessera", function () {
    let conn, ethers, networkHelpers, me;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ({ ethers, networkHelpers } = conn);
        [me] = await ethers.getSigners();
    });

    // A Tessera id for a pair: the entry in the low 160 bits, the pair's tag in the 96 above.
    function tesseraId(entry, t0, t1) {
        const tag = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [t0, t1]))) & ((1n << 96n) - 1n);
        return ethers.toBeHex((tag << 160n) | BigInt(entry), 32);
    }

    async function sorted(...names) {
        const ts = [];
        for (const n of names) ts.push(await deploy(conn, "MockERC20", null, [n, n]));
        const addrs = await Promise.all(ts.map((t) => t.getAddress()));
        return ts.map((t, i) => [t, addrs[i]]).sort((a, b) => (a[1].toLowerCase() < b[1].toLowerCase() ? -1 : 1)).map(([t]) => t);
    }

    // The entry, its treasury at Chain.TESSERA_TREASURY holding 100,000 of each token, and a rate of
    // 0.999 each way: a mid of one, and a 10 bps half-spread.
    async function tessera(tokens) {
        const treasury = await deploy(conn, "MockTesseraTreasury", TREASURY);
        const entry = await deploy(conn, "MockTessera", null, [TREASURY]);
        await treasury.setEntry(await entry.getAddress());
        for (const t of tokens) await t.mint(TREASURY, 100_000n * ONE);
        for (const a of tokens) for (const b of tokens) if (a !== b) await entry.setRate(await a.getAddress(), await b.getAddress(), 999n * ONE / 1000n);
        return entry;
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

    async function frontRun(A, pool, amt) {
        const [r0, r1] = await pool.getReserves();
        await A.mint(await pool.getAddress(), amt);
        await pool.swap(0n, v2Out(amt, r0, r1, 9970n, 10000n), me.address, "0x");
    }

    function captured(vh, rc) {
        return rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
    }

    async function warded() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), ADMIN], LIBS);
        return { registry, vh };
    }

    it("prices a pair from the entry's own quotes: the mid, and its bid and ask as the fee", async function () {
        const [A, B] = await sorted("A", "B");
        const entry = await tessera([A, B]);
        const harness = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
        const [s, fn, fd] = await harness.marketPrice(TESSERA, await entry.getAddress(), await A.getAddress(), await B.getAddress());
        expect(s).to.be.closeTo(Q96, Q96 / 10n ** 12n);
        expect(fn * 10_000n / fd).to.be.within(9_989n, 9_990n);
    });

    it("anchors three pairs with one entry, each under its own id, and leaves no allowance", async function () {
        const [A, B, C] = await sorted("A", "B", "C");
        const entry = await tessera([A, B, C]);
        const { registry, vh } = await warded();
        const at = await entry.getAddress();
        for (const [x, y] of [[A, B], [A, C], [B, C]]) {
            const [t0, t1] = [await x.getAddress(), await y.getAddress()];
            const pool = await v2(x, y, 1_000n * ONE);
            await registry.setPools(t0, t1, [[tesseraId(at, t0, t1), TESSERA, 0, 0], [idAddr(await pool.getAddress()), 0, 30, 0]]);
            await frontRun(x, pool, 30n * ONE);
            const rc = await (await vh["ward(bytes32,address)"](idAddr(await pool.getAddress()), PAYEE, { gasLimit: 5_000_000 })).wait();
            const [ev] = captured(vh, rc);
            expect(ev, "a capture").to.not.equal(undefined);
            expect(ev.args.anchor).to.equal(tesseraId(at, t0, t1));
            expect(ev.args.bounty).to.be.gt(0n);
            for (const t of [x, y]) {
                expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
                expect(await t.allowance(await vh.getAddress(), at)).to.equal(0n);
            }
        }
    });

    it("does nothing when the entry refuses the pair, or quotes past what its treasury holds", async function () {
        const [A, B] = await sorted("A", "B");
        const entry = await tessera([A, B]);
        const { registry, vh } = await warded();
        const [t0, t1] = [await A.getAddress(), await B.getAddress()];
        const pool = await v2(A, B, 1_000n * ONE);
        const id = idAddr(await pool.getAddress());
        await registry.setPools(t0, t1, [[tesseraId(await entry.getAddress(), t0, t1), TESSERA, 0, 0], [id, 0, 30, 0]]);
        await frontRun(A, pool, 30n * ONE);

        await entry.setRefuse(true);
        await expect(vh.execute(id, PAYEE)).to.be.revertedWith("REFUSED");
        const rc = await (await vh["ward(bytes32,address)"](id, PAYEE, { gasLimit: 5_000_000 })).wait();
        expect(captured(vh, rc)).to.have.length(0);

        await entry.setRefuse(false);
        await entry.setRate(t0, t1, 2_000n * ONE); // a reference size of A now quotes twice what the treasury holds of B
        await expect(vh.execute(id, PAYEE)).to.be.revertedWith("REFUSED");
    });
});
