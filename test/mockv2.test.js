import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

const ONE = 10n ** 18n;

// exact-in constant-product amountOut, fee 9975/10000
function amtOut(inp, rIn, rOut) {
    const n = inp * 9975n * rOut;
    const d = rIn * 10000n + inp * 9975n;
    return n / d;
}

describe("MockV2Pool", function () {
    let conn, ethers;
    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
    });

    async function mkToken(sym) {
        return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]);
    }

    it("prefunded swap follows constant-product and holds the invariant", async function () {
        const [me] = await ethers.getSigners();
        let a = await mkToken("A");
        let b = await mkToken("B");
        // sort so token0 < token1
        if ((await a.getAddress()).toLowerCase() > (await b.getAddress()).toLowerCase()) [a, b] = [b, a];
        const pool = await deploy(conn, "MockV2Pool", null, [await a.getAddress(), await b.getAddress(), 9975, 10000]);

        // mint 2000 A so 1000 seeds the reserve and 1000 is left for the swap input
        await a.mint(me.address, 2000n * ONE);
        await b.mint(me.address, 1000n * ONE);
        await a.approve(await pool.getAddress(), 2000n * ONE);
        await b.approve(await pool.getAddress(), 1000n * ONE);
        await pool.initReserves(1000n * ONE, 1000n * ONE); // pulls 1000 A + 1000 B, leaves me 1000 A, 0 B

        const inAmt = 10n * ONE;
        const out = amtOut(inAmt, 1000n * ONE, 1000n * ONE);
        // pre-fund the input, take the output; me held 0 B, so its B balance becomes `out`
        await a.transfer(await pool.getAddress(), inAmt);
        await pool.swap(0, out, me.address, "0x");
        expect(await b.balanceOf(me.address)).to.equal(out);
    });

    it("under-repaid swap violates the k-invariant and reverts", async function () {
        const [me] = await ethers.getSigners();
        let a = await mkToken("A");
        let b = await mkToken("B");
        // sort so token0 < token1
        if ((await a.getAddress()).toLowerCase() > (await b.getAddress()).toLowerCase()) [a, b] = [b, a];
        const pool = await deploy(conn, "MockV2Pool", null, [await a.getAddress(), await b.getAddress(), 9975, 10000]);

        // mint 2000 A so 1000 seeds the reserve and 1000 is left for the swap input
        await a.mint(me.address, 2000n * ONE);
        await b.mint(me.address, 1000n * ONE);
        await a.approve(await pool.getAddress(), 2000n * ONE);
        await b.approve(await pool.getAddress(), 1000n * ONE);
        await pool.initReserves(1000n * ONE, 1000n * ONE); // pulls 1000 A + 1000 B, leaves me 1000 A, 0 B

        // transfer tiny token0 input (barely passes IN_0 check) but request large token1 output
        await a.transfer(await pool.getAddress(), 1n);
        // try to extract 5e18 B with only 1 wei A input, which violates the k-invariant
        await expect(pool.swap(0, 5n * ONE, me.address, "0x")).to.be.revert(ethers);
    });
});
