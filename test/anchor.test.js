import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { v2Out } from "./lib/pool-model.js";

// The anchor a ward restores against: always the first pool the registry lists for the pair
// other than the warded one. The node keeps each pair's list deepest first, so that is the
// deepest other pool, and a caller has no say in it. Mock V2 pools, no fork.

const ONE = 10n ** 18n;
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const LIBS = {
    libraries: {
        CurveLib: null, UniV4Lib: null, InfinityLib: null,
        V3Depth: null, V4Depth: null, RouteLib: null,
    },
};

describe("VanHelsing anchor", function () {
    let conn, ethers, me;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
    });

    async function token(name) {
        return deploy(conn, "MockERC20", null, [name, name]);
    }

    async function v2Pool(t0, t1, r0, r1) {
        const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), 9975n, 10000n]);
        await t0.mint(me.address, r0);
        await t1.mint(me.address, r1);
        await t0.approve(await pool.getAddress(), r0);
        await t1.approve(await pool.getAddress(), r1);
        await pool.initReserves(r0, r1);
        return pool;
    }

    // A defended pool front-run by 30 of token0, a shallow pool and a pool ten times deeper, all
    // at the same price before the front-run; and a pool of another pair sharing token0. order
    // lists the pair's pools in the registry.
    async function setup(order = (ids) => [ids.deep, ids.def, ids.shallow]) {
        let [A, B] = [await token("A"), await token("B")];
        if ((await A.getAddress()).toLowerCase() > (await B.getAddress()).toLowerCase()) [A, B] = [B, A];
        const def = await v2Pool(A, B, 1000n * ONE, 1000n * ONE);
        const shallow = await v2Pool(A, B, 1000n * ONE, 1000n * ONE);
        const deep = await v2Pool(A, B, 10000n * ONE, 10000n * ONE);
        const C = await token("C");
        const [x0, x1] = (await A.getAddress()).toLowerCase() < (await C.getAddress()).toLowerCase() ? [A, C] : [C, A];
        const elsewhere = await v2Pool(x0, x1, 1000n * ONE, 1000n * ONE);

        const amt = 30n * ONE;
        const [r0, r1] = await def.getReserves();
        await A.mint(await def.getAddress(), amt);
        await def.swap(0n, v2Out(amt, r0, r1, 9975n, 10000n), me.address, "0x");

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], LIBS);
        const ids = {
            def: idAddr(await def.getAddress()),
            shallow: idAddr(await shallow.getAddress()),
            deep: idAddr(await deep.getAddress()),
            elsewhere: idAddr(await elsewhere.getAddress()),
        };
        await registry.setPools(await A.getAddress(), await B.getAddress(), order(ids).map((id) => [id, 0, 25, 0]));
        await registry.setPools(await A.getAddress(), await C.getAddress(), [[ids.elsewhere, 0, 25, 0]]);
        return { vh, ids };
    }

    async function captured(vh, rc) {
        return rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "Captured");
    }

    it("has no ward that takes an anchor", async function () {
        const { vh } = await setup();
        expect(vh.interface.getFunction("ward(bytes32,address,bytes32)")).to.equal(null);
        expect(vh.interface.getFunction("execute(bytes32,address,bytes32)")).to.equal(null);
    });

    it("restores against the deepest other listed pool, wherever the warded pool is listed", async function () {
        for (const order of [(ids) => [ids.deep, ids.def, ids.shallow], (ids) => [ids.def, ids.deep, ids.shallow]]) {
            const { vh, ids } = await setup(order);
            const ev = await captured(vh, await (await vh["ward(bytes32,address)"](ids.def, TREASURY, { gasLimit: 3_000_000 })).wait());
            expect(ev.args.anchor).to.equal(ids.deep);
        }
    });

    it("warding the deepest pool anchors on the second deepest", async function () {
        const { vh, ids } = await setup((ids) => [ids.def, ids.shallow]);
        const ev = await captured(vh, await (await vh["ward(bytes32,address)"](ids.def, TREASURY, { gasLimit: 3_000_000 })).wait());
        expect(ev.args.anchor).to.equal(ids.shallow);
    });
});
