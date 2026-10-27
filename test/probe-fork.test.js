import { network } from "hardhat";
import { expect } from "chai";
import { toBeHex, zeroPadValue } from "ethers";
import { deploy } from "../lib/contract.js";
import { describeFork } from "./helpers/fork.js";

// The Van Helsing node's V4 and Infinity probes (contracts/probe) on BSC's real singletons: each
// swaps a pool exact-in each way, paying from and taking to its own balances. The node runs them
// on hooked pools only, but a hook does not change the probe's path: these pools have none, and
// a fee no live pool uses, so their keys are fresh.

const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF"; // Uniswap V4 PoolManager on BSC
const CL = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b"; // Pancake Infinity CL pool manager
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849"; // its price opens the pools
const USDT_HOLDER = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const BLOCK = 103808000;
const ONE = 10n ** 18n;
const FEE = 1234;
const L = 3n * 10n ** 21n;

describeFork("PoolProbe on the singletons", function () {
    let conn, ethers, networkHelpers, usdt, wbnb, price;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        usdt = await ethers.getContractAt("IERC20", USDT);
        wbnb = await ethers.getContractAt("IWETH", WBNB);
        const v3 = new ethers.Contract(V3_DEEP, ["function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint32, bool)"], ethers.provider);
        [price] = await v3.slot0();
    });

    async function fund(to) {
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, 100n * ONE);
        await wbnb.connect(whale).deposit({ value: 60n * ONE });
        await wbnb.connect(whale).transfer(to, 60n * ONE);
        await networkHelpers.impersonateAccount(USDT_HOLDER);
        await networkHelpers.setBalance(USDT_HOLDER, ONE);
        await usdt.connect(await ethers.getSigner(USDT_HOLDER)).transfer(to, 30_000n * ONE);
        await networkHelpers.stopImpersonatingAccount(USDT_HOLDER);
    }

    // Opens key on its manager at the deep pool's price, with liquidity around it.
    async function open(helperName, manager, initAbi, key) {
        const helper = await deploy(conn, helperName);
        await fund(await helper.getAddress());
        const [signer] = await ethers.getSigners();
        await new ethers.Contract(manager, [initAbi], signer).initialize(key, price);
        const [, tick] = await helper.price(key);
        const lower = Math.floor((Number(tick) - 3000) / 10) * 10;
        await helper.addLiquidity(key, lower, lower + 6000, L);
    }

    async function swapsBothWays(probeName, key) {
        const probe = await deploy(conn, probeName);
        await fund(await probe.getAddress());
        const before = await wbnb.balanceOf(await probe.getAddress());
        const out = await probe.swap.staticCall(key, true, 100n * ONE); // USDT in, WBNB out
        expect(out > 0n).to.equal(true);
        await (await probe.swap(key, true, 100n * ONE)).wait();
        expect(await wbnb.balanceOf(await probe.getAddress())).to.equal(before + out);
        const back = await probe.swap.staticCall(key, false, out); // WBNB in, USDT out
        expect(back > 0n && back < 100n * ONE).to.equal(true);
    }

    it("swaps a V4 pool each way", async function () {
        const key = [USDT, WBNB, FEE, 10, NO_HOOKS];
        await open("V4PoolHelper", PM, "function initialize((address,address,uint24,int24,address),uint160) returns (int24)", key);
        await swapsBothWays("V4Probe", key);
    });

    it("swaps an Infinity CL pool each way", async function () {
        const key = [USDT, WBNB, NO_HOOKS, CL, FEE, zeroPadValue(toBeHex(10 << 16), 32)];
        await open("InfinityPoolHelper", CL, "function initialize((address,address,address,address,uint24,bytes32),uint160) returns (int24)", key);
        await swapsBothWays("InfinityProbe", key);
    });
});
