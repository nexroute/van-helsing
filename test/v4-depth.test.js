import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
// Uniswap V4 WBNB/USDT pool (see univ4-fork.test.js), as packed config bytes.
const CFG = configV4([4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]);
const BLOCK = 103808000;

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

// V4Depth's walk is a verbatim port of the fork-tested V3Depth; what differs is the reads
// (slot0 / liquidity / tick / bitmap by poolId, straight from the manager's storage). These
// assertions pin the boundary cases exactly and prove the walk runs over a real pool's
// ticks without reverting. The depth VALUE is checked by the arbs of univ4-fork.test.js
// (a mis-sized restore fails to profit or reverts).
describeFork("V4Depth.effectiveLiquidity (Uniswap V4)", function () {
    let depth, curSqrt, spot;

    before(async function () {
        this.timeout(120000);
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const reader = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
        [curSqrt, spot] = await reader.normalize(CFG);
    });

    it("returns spot liquidity when the target equals the current price", async function () {
        expect(await depth.effectiveLiquidity(CFG, curSqrt, 8)).to.equal(spot);
    });

    it("returns spot liquidity when maxTicks is zero", async function () {
        expect(await depth.effectiveLiquidity(CFG, MAX_SQRT, 0)).to.equal(spot);
    });

    it("walks real ticks up and down without reverting, staying positive", async function () {
        const up = await depth.effectiveLiquidity(CFG, MAX_SQRT, 8);
        const down = await depth.effectiveLiquidity(CFG, MIN_SQRT + 1n, 8);
        expect(up).to.be.gt(0n);
        expect(down).to.be.gt(0n);
        // deterministic: same inputs, same read
        expect(await depth.effectiveLiquidity(CFG, MAX_SQRT, 8)).to.equal(up);
    });
});
