import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const Q96 = 1n << 96n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const MIN_SQRT = 4295128740n;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const BLOCK = 103808000;

// tick k has sqrtPrice ~= 1.0001^(k/2) * 2^96; build a target that sits a known number
// of compressed ticks away so the walk's clip is exercised precisely.
function sqrtAtTick(tick) {
    return BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
}

describeFork("V3Depth bounded walk", function () {
    let conn, ethers, v3d;
    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        v3d = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
    });

    // deep core [-100,+100] with liquidity D, thin skirt [-2000,+2000] with liquidity T.
    async function cliffy(D, T) {
        const t0 = "0x1111111111111111111111111111111111111111";
        const t1 = "0x2222222222222222222222222222222222222222";
        const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D + T, 10, t0, t1]);
        await pool.setTick(-2000, T);
        await pool.setTick(-100, D);
        await pool.setTick(100, -D);
        await pool.setTick(2000, -T);
        return pool;
    }

    it("returns near-spot depth for a target inside the deep core, not the 8-tick collapse", async function () {
        const D = 10n ** 24n, T = 10n ** 20n;
        const pool = await cliffy(D, T);
        const addr = await pool.getAddress();
        // target 5 compressed ticks up (tick +50), well inside the deep core [-100,+100]
        const nearTarget = sqrtAtTick(50);
        const lNear = await v3d.effectiveLiquidity(addr, nearTarget, 8);
        // to the extreme (MAX), 8 ticks: crosses the cliff into the thin skirt
        const lFar = await v3d.effectiveLiquidity(addr, MAX_SQRT, 8);
        // bounded-at-near reads the deep core (~D+T); far reads the collapsed mean
        expect(lNear).to.be.gt(lFar * 5n); // deep vs collapsed
        expect(lNear).to.be.gte(D); // essentially the core depth
    });

    it("returns near-spot depth for a target inside the deep core, walking down, not the 8-tick collapse", async function () {
        const D = 10n ** 24n, T = 10n ** 20n;
        const pool = await cliffy(D, T);
        const addr = await pool.getAddress();
        // target 5 compressed ticks down (tick -50), well inside the deep core [-100,+100]
        const nearTarget = sqrtAtTick(-50);
        const lNear = await v3d.effectiveLiquidity(addr, nearTarget, 8);
        // to the extreme (MIN), 8 ticks: crosses the cliff into the thin skirt
        const lFar = await v3d.effectiveLiquidity(addr, MIN_SQRT, 8);
        // bounded-at-near reads the deep core (~D+T); far reads the collapsed mean
        expect(lNear).to.be.gt(lFar * 5n); // deep vs collapsed
        expect(lNear).to.be.gte(D); // essentially the core depth
    });

    it("a target beyond all liquidity reads like an unbounded maxTicks walk (uniform pool)", async function () {
        const D = 10n ** 24n;
        const t0 = "0x1111111111111111111111111111111111111111";
        const t1 = "0x2222222222222222222222222222222222222222";
        const pool = await deploy(conn, "MockV3TickPool", null, [Q96, 0, D, 10, t0, t1]);
        await pool.setTick(-5000, D);
        await pool.setTick(5000, -D);
        const addr = await pool.getAddress();
        // uniform depth -> bounded and unbounded both read D
        expect(await v3d.effectiveLiquidity(addr, MAX_SQRT, 8)).to.equal(D);
        expect(await v3d.effectiveLiquidity(addr, sqrtAtTick(30), 8)).to.equal(D);
    });
});

// real V4 USDT/WBNB pool (see univ4-fork.test.js / v4-depth.test.js), as packed config bytes.
describeFork("V4Depth bounded walk (Uniswap V4 fork)", function () {
    let v4d, v4reader, cfg;

    before(async function () {
        this.timeout(120000);
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        v4d = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        v4reader = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
        cfg = configV4([4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]);
    });

    it("real V4 USDT/WBNB: near-spot target reads deeper than the extreme", async function () {
        const cur = (await v4reader.normalize(cfg))[0]; // current sqrtPrice
        const near = cur + cur / 1000n; // ~20 raw ticks / 2 compressed spans up
        const lNear = await v4d.effectiveLiquidity(cfg, near, 8);
        const lFar = await v4d.effectiveLiquidity(cfg, MAX_SQRT, 8);
        console.log(`  [V4 USDT/WBNB] near=${lNear} far(extreme)=${lFar} ratio=${Number(lNear) / Number(lFar)}x`);
        expect(lNear).to.be.gt(lFar * 2n); // measured cliff ~6.5x toward MAX
    });
});
