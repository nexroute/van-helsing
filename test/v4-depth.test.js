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

// A dry walk (the pool a ward sinks into) on a real PoolManager: a fresh pool at price 1, spacing
// 10, its only liquidity in [-20, +20]. Toward compressed tick 10 (or -10) it runs dry at tick 20
// (or -20): the plain walk reads L, the dry one what [-20, +20] holds of the way, in sqrt price.
describeFork("V4Depth.effectiveLiquidity, dry (Uniswap V4)", function () {
    const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF";
    const ONE = 10n ** 18n;
    const L = 10n ** 19n;
    const sqrtAtTick = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
    let depth, cfg;

    before(async function () {
        this.timeout(120000);
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        const [signer] = await conn.ethers.getSigners();
        depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
        const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
        const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
        const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
        const key = [c0, c1, 500, 10, NO_HOOKS];
        const pm = new conn.ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        await (await pm.initialize(key, 2n ** 96n)).wait();
        const helper = await deploy(conn, "V4PoolHelper");
        await t0.mint(await helper.getAddress(), 100n * ONE);
        await t1.mint(await helper.getAddress(), 100n * ONE);
        await (await helper.addLiquidity(key, -20, 20, L)).wait();
        cfg = configV4([4, c0, c1, 500, 10, NO_HOOKS, ZH]);
    });

    const want = (target) => {
        const t = Number(target) / 2 ** 96;
        if (t > 1) { const e = Math.sqrt(1.0001 ** 20); return (Number(L) * (e - 1)) / (t - 1); }
        const e = Math.sqrt(1.0001 ** -20);
        return (((Number(L) * (1 - e)) / (1 - t)) * t) / e;
    };
    const near = (got, w) => expect(Math.abs(Number(got) / w - 1)).to.be.lt(1e-9);

    it("reads what the pool holds of the way to its target, up and down", async function () {
        for (const target of [sqrtAtTick(105), sqrtAtTick(-95)]) {
            expect(await depth.effectiveLiquidity(cfg, target, 8)).to.equal(L);
            near(await depth.effectiveLiquidityDry(cfg, target, 8), want(target));
        }
    });

    it("replays a nearer dry walk from the record of a farther one", async function () {
        for (const [far, nearer] of [[sqrtAtTick(105), sqrtAtTick(55)], [sqrtAtTick(-95), sqrtAtTick(-45)]]) {
            const [walked, fromRecord, covered] = await depth.replayedDry(cfg, far, nearer, 8);
            expect(covered).to.equal(true);
            expect(fromRecord).to.equal(walked);
            near(walked, want(nearer));
        }
    });
});

// Liquidity that comes back past a gap, on a real PoolManager: a fresh pool at price 1, spacing 10,
// liquid in [-20, 20], and again in [40, 1000] and [-1000, -40]. A walk toward compressed tick 10 or
// -10 crosses a gap into the second island, so it keeps no cliff; a pool whose second island starts
// past the target keeps the first one's end.
describeFork("V4Depth.effectiveLiquidity across a gap (Uniswap V4)", function () {
    const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF";
    const ONE = 10n ** 18n;
    const L = 10n ** 19n;
    const sqrtAtTick = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
    let depth, islands, far;

    before(async function () {
        this.timeout(120000);
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        const [signer] = await conn.ethers.getSigners();
        depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const pm = new conn.ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        const helper = await deploy(conn, "V4PoolHelper");
        const make = async (ranges) => {
            const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
            const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
            const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
            const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
            const key = [c0, c1, 500, 10, NO_HOOKS];
            await (await pm.initialize(key, 2n ** 96n)).wait();
            await t0.mint(await helper.getAddress(), 1000n * ONE);
            await t1.mint(await helper.getAddress(), 1000n * ONE);
            for (const [lo, hi] of ranges) await (await helper.addLiquidity(key, lo, hi, L)).wait();
            return configV4([4, c0, c1, 500, 10, NO_HOOKS, ZH]);
        };
        islands = await make([[-20, 20], [40, 1000], [-1000, -40]]);
        far = await make([[-20, 20], [200, 1000]]);
    });

    it("keeps no cliff where liquidity comes back before the target, either way", async function () {
        for (const target of [sqrtAtTick(105), sqrtAtTick(-95)]) expect(await depth.cliffOf(islands, target, 8)).to.equal(0n);
        expect(await depth.cliffOf(far, sqrtAtTick(105), 8)).to.equal(79307426338960776842885539845n); // tick 20
    });
});
