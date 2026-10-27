import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { isqrt } from "./lib/pool-model.js";

// The Van Helsing node's V3 probe (contracts/probe/V3Probe.sol): it swaps any V3-shaped pool
// exact-in each way, paying from its own balance through the pool's swap callback, whatever its
// name.

const ONE = 10n ** 18n;

describe("PoolProbe", function () {
    let conn, ethers, me;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
    });

    it("swaps a V3 pool each way through its callback", async function () {
        let [A, B] = [await deploy(conn, "MockERC20", null, ["A", "A"]), await deploy(conn, "MockERC20", null, ["B", "B"])];
        if ((await A.getAddress()).toLowerCase() > (await B.getAddress()).toLowerCase()) [A, B] = [B, A];
        const r = 1000n * ONE;
        const pool = await deploy(conn, "MockV3SwapPool", null, [await A.getAddress(), await B.getAddress(), 500, isqrt((r << 192n) / r), 0, isqrt(r * r)]);
        await A.mint(await pool.getAddress(), r);
        await B.mint(await pool.getAddress(), r);
        const probe = await deploy(conn, "V3Probe");
        await A.mint(await probe.getAddress(), 10n * ONE);

        const [a0, a1] = await probe.swap.staticCall(await pool.getAddress(), true, 10n * ONE);
        expect(a0).to.equal(10n * ONE);
        expect(a1 < 0n, "the pool paid token 1 out").to.equal(true);
        await (await probe.swap(await pool.getAddress(), true, 10n * ONE)).wait();
        const got = await B.balanceOf(await probe.getAddress());
        expect(got).to.equal(-a1);

        const [b0, b1] = await probe.swap.staticCall(await pool.getAddress(), false, got);
        expect(b1).to.equal(got);
        expect(b0 < 0n && -b0 < 10n * ONE, "the round trip paid both fees").to.equal(true);
    });
});
