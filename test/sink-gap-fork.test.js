import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// A sink whose price sits in a gap of its liquidity. Pass 1 walks it toward the other pool's
// price, across the gap into the liquidity past it; its pass-1 meeting price lands inside the
// gap, so pass 2's walk toward it reads no liquidity at all. A zero depth is what the meeting
// price takes for a pool in a gap, restored to in full: kept, it would drive the warded pool all
// the way to the sink's own price, while the sink, jumping the gap, ends well past it. The sink
// keeps its pass-1 depth instead.

const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF"; // Uniswap V4 PoolManager
const V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"; // PancakeSwap V2
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const BLOCK = 103808000;
const ONE = 10n ** 18n;
const Q96 = 1n << 96n;
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };

describeFork("VanHelsing against a sink whose price sits in a liquidity gap (fork)", function () {
    let conn, ethers;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
    });

    it("drives the warded pool to the meeting price of the sink's pass-1 depth, not to the sink's price", async function () {
        const [signer] = await ethers.getSigners();
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
        const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
        const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
        const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];

        // The anchor: a Uniswap V4 pool at a price of 1, its liquidity only from tick 100 up.
        const meta = [4, c0, c1, 500, 10, NO_HOOKS, ZH];
        const key = [c0, c1, 500, 10, NO_HOOKS];
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        await (await pm.initialize(key, Q96)).wait();
        const helper = await deploy(conn, "V4PoolHelper");
        await t0.mint(await helper.getAddress(), 100n * ONE);
        await t1.mint(await helper.getAddress(), 100n * ONE);
        await (await helper.addLiquidity(key, 100, 6000, 10n ** 19n)).wait();

        // The warded pool: a PancakeSwap V2 pair at a sqrt price of 1.02, liquidity 1e18.
        const factory = new ethers.Contract(V2_FACTORY, ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"], signer);
        await (await factory.createPair(c0, c1)).wait();
        const pair = await factory.getPair(c0, c1);
        await t0.mint(pair, ONE * 100n / 102n);
        await t1.mint(pair, ONE * 102n / 100n);
        await (await new ethers.Contract(pair, ["function mint(address) returns (uint256)"], signer).mint(signer.address)).wait();

        const id = idV4(meta);
        await registry.setConfig(id, configV4(meta));
        await registry.setPools(c0, c1, [[id, 4, 500, 0], [idAddr(pair), 0, 25, 0]]);

        const rc = await (await vh["ward(bytes32,address)"](idAddr(pair), BENEFICIARY, { gasLimit: 6_000_000 })).wait();
        const captured = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
        expect(captured, "the ward captures").to.not.equal(undefined);
        expect(captured.args.bounty).to.be.gt(0n);
        // A full restore would leave the pair at a price of 1; the pass-1 meeting price is about
        // 1.003 in sqrt price, a price above 1.002.
        const [r0, r1] = await new ethers.Contract(pair, ["function getReserves() view returns (uint112, uint112, uint32)"], signer).getReserves();
        expect(r1 * 1_000_000n).to.be.gt(r0 * 1_002_001n, `the pair is driven to ${Number(r1 * 1_000_000n / r0) / 1e6}, the sink's own price`);
    });
});
