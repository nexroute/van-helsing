import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { v2Out } from "./lib/pool-model.js";

// Who a bounty goes to. ward(id, payee) pays the bounty to `payee`, or to its caller when
// `payee` is zero, less VanHelsing's CUT_BPS, which goes to the treasury VanHelsing was
// deployed with. Every case restores the same front-run on two mock V2 pools and reads the
// split off the Captured event and the balances.

const ONE = 10n ** 18n;
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const ZERO = "0x0000000000000000000000000000000000000000";
const LIBS = {
    libraries: {
        CurveLib: null, UniV4Lib: null, InfinityLib: null,
        V3Depth: null, V4Depth: null, RouteLib: null,
    },
};

describe("VanHelsing bounty", function () {
    let conn, ethers, me, alice;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me, alice] = await ethers.getSigners();
    });

    async function v2Pool(t0, t1, r0, r1) {
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), 9975n, 10000n]);
        await t0.mint(me.address, r0);
        await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0);
        await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return pool;
    }

    // Two equal V2 pools, the defended one front-run by 30 of token0 so it sits below the
    // anchor and a restore has something to capture.
    async function setup() {
        let [A, B] = [await deploy(conn, "MockERC20", null, ["A", "A"]), await deploy(conn, "MockERC20", null, ["B", "B"])];
        if ((await A.getAddress()).toLowerCase() > (await B.getAddress()).toLowerCase()) [A, B] = [B, A];
        const def = await v2Pool(A, B, 1000n * ONE, 1000n * ONE);
        const anchor = await v2Pool(A, B, 1000n * ONE, 1000n * ONE);

        const amt = 30n * ONE;
        const [r0, r1] = await def.getReserves();
        await A.mint(await def.getAddress(), amt);
        await def.swap(0n, v2Out(amt, r0, r1, 9975n, 10000n), me.address, "0x");

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], LIBS);
        await registry.setPools(await A.getAddress(), await B.getAddress(), [
            [idAddr(await def.getAddress()), 0, 25, 0],
            [idAddr(await anchor.getAddress()), 0, 25, 0],
        ]);
        return { A, B, def, anchor, vh, id: idAddr(await def.getAddress()) };
    }

    // The Captured event of a mined ward or execute, and every party's balance change in
    // the bounty's token.
    async function run(s, send, parties) {
        const tokens = [s.A, s.B];
        const before = await Promise.all(parties.flatMap((p) => tokens.map((t) => t.balanceOf(p))));
        const rc = await (await send()).wait();
        const ev = rc.logs.map((l) => { try { return s.vh.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "Captured");
        expect(ev, "a restore happened").to.not.equal(undefined);
        const i = (await s.A.getAddress()) === ev.args.token ? 0 : 1;
        const after = await Promise.all(parties.flatMap((p) => tokens.map((t) => t.balanceOf(p))));
        const delta = parties.map((_, k) => after[k * 2 + i] - before[k * 2 + i]);
        expect(await tokens[i].balanceOf(await s.vh.getAddress()), "nothing is left in VanHelsing").to.equal(0n);
        return { ev, delta };
    }

    it("pays the caller when payee is zero, less the 10% cut to the treasury", async function () {
        const s = await setup();
        const { ev, delta } = await run(s, () => s.vh["ward(bytes32,address)"](s.id, ZERO, { gasLimit: 3_000_000 }), [me.address, TREASURY]);
        const bounty = ev.args.bounty;
        const cut = (bounty * 1000n) / 10000n;
        expect(bounty > 0n).to.equal(true);
        expect(ev.args.pool).to.equal(s.id);
        expect(ev.args.anchor).to.equal(idAddr(await s.anchor.getAddress()));
        expect(ev.args.payee, "the event names whoever was paid").to.equal(me.address);
        expect(delta[0], "the caller gets the bounty less the cut").to.equal(bounty - cut);
        expect(delta[1], "the treasury gets 10%").to.equal(cut);
        expect(await s.vh.CUT_BPS()).to.equal(1000n);
    });

    it("pays a named recipient, and nothing to the caller", async function () {
        const s = await setup();
        const { ev, delta } = await run(s, () => s.vh["ward(bytes32,address)"](s.id, alice.address, { gasLimit: 3_000_000 }),
            [alice.address, TREASURY, me.address]);
        const cut = (ev.args.bounty * 1000n) / 10000n;
        expect(ev.args.payee).to.equal(alice.address);
        expect(delta[0]).to.equal(ev.args.bounty - cut);
        expect(delta[1]).to.equal(cut);
        expect(delta[2], "the caller keeps nothing it did not ask for").to.equal(0n);
    });

    it("pays the treasury the whole bounty when it is the recipient", async function () {
        const s = await setup();
        const { ev, delta } = await run(s, () => s.vh["ward(bytes32,address)"](s.id, TREASURY, { gasLimit: 3_000_000 }), [TREASURY]);
        expect(delta[0]).to.equal(ev.args.bounty);
    });

    it("pays a direct execute's caller when payee is zero", async function () {
        const s = await setup();
        const { ev, delta } = await run(s, () => s.vh.connect(alice).execute(s.id, ZERO, { gasLimit: 3_000_000 }),
            [alice.address, TREASURY]);
        const cut = (ev.args.bounty * 1000n) / 10000n;
        expect(ev.args.payee).to.equal(alice.address);
        expect(delta[0]).to.equal(ev.args.bounty - cut);
        expect(delta[1]).to.equal(cut);
    });

    it("pays nobody when there is nothing to restore", async function () {
        const s = await setup();
        await s.vh["ward(bytes32,address)"](s.id, ZERO, { gasLimit: 3_000_000 }); // captures the gap
        const before = [await s.A.balanceOf(me.address), await s.B.balanceOf(me.address)];
        const rc = await (await s.vh["ward(bytes32,address)"](s.id, ZERO, { gasLimit: 3_000_000 })).wait();
        const captured = rc.logs.filter((l) => { try { return s.vh.interface.parseLog(l)?.name === "Captured"; } catch { return false; } });
        expect(captured.length, "a restored pool has no second bounty").to.equal(0);
        expect([await s.A.balanceOf(me.address), await s.B.balanceOf(me.address)]).to.deep.equal(before);
    });
});
