import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";

// A taxed exact-in V3 sink that its price limit stops. A V2 pair cheap in T, a token taxed in and
// out of the anchor, sells T into a CliffV3Pool anchor (spacing 1) whose liquidity ends at tick
// -2100, past the 8 bitmap words its depth walk reads, so no cliff caps the drive: the anchor runs
// dry and stops at its limit. V3Lib.pay pays the whole taxed balance, so the full-fill rule must
// still stop the ward (SINK_SHORT) and leave nothing in VanHelsing. No fork.
const ONE = 10n ** 18n;
const Q96 = 1n << 96n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const LIBS = { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } };
const taxWord = ({ in0 = 0, out0 = 0, in1 = 0, out1 = 0 }) => (BigInt(in0) << 48n) | (BigInt(out0) << 32n) | (BigInt(in1) << 16n) | BigInt(out1);
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

describe("A taxed exact-in V3 sink stopped by its limit", function () {
    let conn, ethers, me;
    before(async function () {
        conn = await network.create({ network: "hardhat", override: process.env.VH_NO_FORK ? undefined : { forking: { enabled: false } } });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
    });

    function reasonOf(e) {
        const data = e.data ?? e.info?.error?.data ?? "";
        if (typeof data === "string" && data.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
        return e.reason ?? (typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : e.shortMessage);
    }

    for (const tax of [0, 100]) it(`stops the ward and leaves nothing behind, T taxed ${tax} bps in and out of the anchor`, async function () {
        let T, B;
        for (;;) {
            T = await deploy(conn, "MockTaxToken", null, ["Taxed", "TAX"]);
            B = await deploy(conn, "MockERC20", null, ["Base", "BASE"]);
            if (BigInt(await T.getAddress()) < BigInt(await B.getAddress())) break; // T is token0
        }
        const [a0, a1] = [await T.getAddress(), await B.getAddress()];
        // anchor at price 1, L in [-2100, 3000], spacing 1
        const anchor = await deploy(conn, "CliffV3Pool", null, [a0, a1, 500, 1, Q96, 10n ** 21n, -2100, 3000]);
        await T.mint(await anchor.getAddress(), 10n ** 25n);
        await B.mint(await anchor.getAddress(), 10n ** 25n);
        // V2 at tick -5000 (T cheap), L 1e21: rB / rT = 1.0001^-5000
        const p = 1.0001 ** -5000;
        const rT = BigInt(Math.floor(1e21 / Math.sqrt(p))), rB = BigInt(Math.floor(1e21 * Math.sqrt(p)));
        const pair = await deploy(conn, "MockV2Pool", null, [a0, a1, 9975n, 10000n]);
        await T.mint(me.address, rT); await B.mint(me.address, rB);
        await T.approve(await pair.getAddress(), rT); await B.approve(await pair.getAddress(), rB);
        await pair.initReserves(rT, rB);
        await T.setTax(await anchor.getAddress(), tax, tax); // out (pool -> us), in (us -> pool)
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], LIBS);
        await registry.setPools(a0, a1, [
            [idAddr(await pair.getAddress()), 0, 25, 0n],
            [idAddr(await anchor.getAddress()), 2, 500, taxWord({ in0: tax, out0: tax })],
        ]);
        let reason = null, bounty = null;
        try {
            const rc = await (await vh.execute(idAddr(await pair.getAddress()), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
            bounty = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty;
        } catch (e) {
            reason = reasonOf(e);
        }
        const [sp] = await anchor.slot0();
        console.log(`      tax ${tax}: execute ${reason ?? `captured ${bounty}`}; anchor price after ${Number(sp) / 2 ** 96}`);
        expect(reason).to.equal("SINK_SHORT");
        // and through ward(): nothing may stay behind, whatever happened
        await (await vh["ward(bytes32,address)"](idAddr(await pair.getAddress()), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
        const left = [await T.balanceOf(await vh.getAddress()), await B.balanceOf(await vh.getAddress())];
        console.log(`      tax ${tax}: after ward() VanHelsing holds ${left}`);
        expect(left).to.deep.equal([0n, 0n]);
    });
});
