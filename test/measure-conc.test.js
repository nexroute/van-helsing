import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4, registerV4 } from "./helpers/ids.js";
import {
    Q96, v2Out, v2Model, concModel, v3Out, v3SwapToTarget, sqrtAtTick,
    profit, sqrtPriceOf, liquidityOf,
} from "./lib/pool-model.js";
import { vanHelsingDriveSize, concLegL } from "./lib/capture.js";
import { readV3Ticks, readV4Ticks, readV4Slot0Liq, crossedTicks } from "./lib/fork-ticks.js";
import { describeFork } from "./helpers/fork.js";

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";

// Fork constants (block 103808000): real USDT/WBNB pools on BSC. USDT sorts to token0
// (0x55.. < 0xbb..), so both pools share token0 = USDT, token1 = WBNB.
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849"; // Pancake V3, 0.01%
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // Pancake V2
const V4_DEEP = [4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]; // Uniswap V4, 0.05%
const BLOCK = 103808000;
const V2_KIND = 0, V3_KIND = 2;
const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;

function clampSqrt(s) { return s < MIN_SQRT ? MIN_SQRT : s > MAX_SQRT ? MAX_SQRT : s; }
function relErr(a, b) { const hi = a > b ? a : b; return hi === 0n ? 0 : Number(((a > b ? a - b : b - a) * 1000000n) / hi) / 1000000; }

describeFork("pool-model engine (concentrated)", function () {
    // A single wide constant-L range behaves like a constant-product pool. This pins the
    // within-tick swap math (the load-bearing piece) before any fork calibration: a gross
    // error in v3Out/sqrtAtTick shows up here as a blown tolerance, not a mysterious 1%
    // miss on the fork.
    it("reduces to V2 for a small swap over a single constant-L range (<= 1e-6)", function () {
        const s = sqrtAtTick(-64075); // a real-ish price, well off tick 0
        const L = 5n * 10n ** 24n;
        const feeNum = 999500n, feeDen = 1000000n; // 0.05%, as V4_DEEP
        // no initialized ticks in range -> L constant, so this is a full-range position.
        const m = concModel(s, -64075, 1, [], feeNum, feeDen, L);
        // equivalent virtual reserves of the full-range position at (s, L).
        const r0 = (L * Q96) / s, r1 = (L * s) / Q96;

        for (const amountIn of [10n ** 15n, 10n ** 18n, 5n * 10n ** 18n]) {
            const cOut0 = v3Out(m, amountIn, true); // token0 in
            const vOut0 = v2Out(amountIn, r0, r1, feeNum, feeDen);
            expect(relErr(cOut0, vOut0), `zeroForOne in=${amountIn} conc=${cOut0} v2=${vOut0}`).to.be.lte(1e-6);

            const cOut1 = v3Out(m, amountIn, false); // token1 in
            const vOut1 = v2Out(amountIn, r1, r0, feeNum, feeDen);
            expect(relErr(cOut1, vOut1), `oneForZero in=${amountIn} conc=${cOut1} v2=${vOut1}`).to.be.lte(1e-6);
        }
    });

    it("v3SwapToTarget input reproduces the same output through v3Out", function () {
        const s = sqrtAtTick(-64075);
        const L = 5n * 10n ** 24n;
        const m = concModel(s, -64075, 1, [{ tick: -64085, liqNet: -(10n ** 23n) }, { tick: -64095, liqNet: -(10n ** 23n) }], 999900n, 1000000n, L);
        const target = sqrtAtTick(-64100); // drive down across two ticks
        const { amountIn, amountOut } = v3SwapToTarget(m, target, true);
        const replay = v3Out(m, amountIn, true);
        // v3Out(chosen) lands at (or a hair past) the target -> output matches to rounding.
        expect(relErr(replay, amountOut), `replay=${replay} swapToTarget=${amountOut}`).to.be.lte(1e-9);
        expect(amountIn).to.be.gt(0n);
        expect(amountOut).to.be.gt(0n);
    });
});

// The tick readers the two fork calibrations share (readV3Ticks/readV4Ticks/
// readV4Slot0Liq/crossedTicks) live in ./lib/fork-ticks.js, shared with
// exec-matrix.test.js; imported above.

describeFork("VanHelsing concentrated capture: FORK CALIBRATION (gate)", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        this.timeout(600000);
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    async function deployStack() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], {
            libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null },
        });
        const mp = await deploy(conn, "MeetingPriceHarness");
        const v3depth = await deploy(conn, "V3DepthHarness", null, [], { libraries: { V3Depth: null } });
        const v4depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        return { registry, vh, h: { mp, v3depth, v4depth, conn } };
    }

    async function v2AltModel() {
        const v2 = new ethers.Contract(V2_PANCAKE, ["function getReserves() view returns (uint112,uint112,uint32)"], ethers.provider);
        const [r0, r1] = await v2.getReserves();
        return v2Model(r0, r1, 9975n, 10000n); // Pancake V2, 0.25%
    }

    // Shared assertion: engine profit(chosen) vs the beneficiary's realized gain within 1%.
    // `dir` is the drive direction (VanHelsing._pickDriver: current price above the meet
    // final -> lower it), computed once by the caller from the meet target. `targetTick`
    // is that same meet target's floor tick, so we can report the ticks the drive really
    // crosses (not the whole read band). `minCrossed`, when > 0, asserts the drive proves
    // real multi-tick crossing instead of just trusting a single-span drive.
    async function assertCalibration(label, h, defModel, altModel, dir, vh, defId, wardGas, targetTick, minCrossed = 0) {
        const chosen = await vanHelsingDriveSize(h, defModel, altModel, dir);
        const chosenProfit = profit(defModel, altModel, chosen, dir);
        expect(chosenProfit, `${label}: engine profit not positive`).to.be.gt(0n);

        // realized: ward and read the beneficiary's balance change in EACH token.
        // VanHelsing pays out a single token (`base` in _payout): t0 (USDT) when the
        // driver's direction (dir) is zeroForOne, t1 (WBNB) otherwise, so the non-payout
        // token's delta must land at exactly 0. Assert that instead of silently summing
        // both deltas.
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const u0 = await usdt.balanceOf(BENEFICIARY), w0 = await wbnb.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](defId, BENEFICIARY, { gasLimit: wardGas });
        const usdtDelta = (await usdt.balanceOf(BENEFICIARY)) - u0;
        const wbnbDelta = (await wbnb.balanceOf(BENEFICIARY)) - w0;
        const [realized, offDelta] = dir ? [usdtDelta, wbnbDelta] : [wbnbDelta, usdtDelta];
        expect(offDelta, `${label}: non-payout token delta should be exactly 0, got ${offDelta}`).to.equal(0n);
        expect(realized, `${label}: nothing realized`).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        const err = relErr(chosenProfit, realized);
        // ticks strictly between spot and target: the ones the restore actually swaps
        // across, not the padded read band (see crossedTicks in ./lib/fork-ticks.js).
        const crossed = crossedTicks(defModel.ticks, defModel.tick, targetTick);
        console.log(`  [${label}] engine=${chosenProfit} realized=${realized} chosen=${chosen} crossed=${crossed} relErr=${(err * 100).toFixed(6)}%`);
        if (minCrossed > 0) {
            expect(crossed, `${label}: expected the drive to provably cross >= ${minCrossed} real initialized ticks, got ${crossed}`).to.be.gte(minCrossed);
        }
        expect(err, `${label}: engine ${chosenProfit} vs realized ${realized} = ${(err * 100).toFixed(4)}%`).to.be.lte(0.01);
        return { chosenProfit, realized, err, chosen, crossed };
    }

    // meet final price + drive direction for a (defended, alt) pair, using the walked L
    // the shipped depth harness reports: exactly VanHelsing's pass-1 sizing inputs.
    async function meetAndDir(h, defModel, altModel, ldWalked) {
        const sd = clampSqrt(sqrtPriceOf(defModel)), sa = clampSqrt(sqrtPriceOf(altModel));
        const [sdF] = await h.mp.meetBoth(sd, ldWalked, defModel.feeNum, defModel.feeDen, sa, liquidityOf(altModel), altModel.feeNum, altModel.feeDen);
        return { target: clampSqrt(BigInt(sdF)), dir: sd > clampSqrt(BigInt(sdF)), sa };
    }

    // ---- GATE 1: real V3 defended, skewed, V2 alt ----
    it("CALIBRATION: engine profit matches a real V3 ward within 1% (V3 defended)", async function () {
        this.timeout(600000);
        const { registry, vh, h } = await deployStack();

        // register the V3 pool (defended) + V2 Pancake (alt/sink). Deep V3 first is fine;
        // the ward drives the defended regardless of ranking.
        await registry.setPools(USDT, WBNB, [[idAddr(V3_DEEP), V3_KIND, 100, 0], [idAddr(V2_PANCAKE), V2_KIND, 25, 0]]);

        // Skew the V3 pool: dump WBNB (token1) in to push its price UP, far off the V2 anchor.
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const poker = await deploy(conn, "PoolPoker");
        const [whale] = await ethers.getSigners();
        const fr = 120n * ONE;
        await networkHelpers.setBalance(whale.address, fr + 100n * ONE);
        await wbnb.connect(whale).deposit({ value: fr });
        await wbnb.connect(whale).transfer(await poker.getAddress(), fr);
        await poker.poke(V3_DEEP, false, fr); // WBNB -> USDT, zeroForOne=false, price up

        // read skewed on-chain state
        const v3 = new ethers.Contract(V3_DEEP, [
            "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint32 d, bool e)",
            "function liquidity() view returns (uint128)",
        ], ethers.provider);
        const s0 = await v3.slot0();
        const spotL = await v3.liquidity();
        const sqrtP = clampSqrt(BigInt(s0.sqrtPriceX96));
        const spotTick = Number(s0.tick);

        // Determine the meet target first (walked L), then load ticks generously spanning
        // [target, spot] so the swap-to-target crosses every real tick.
        const altModel = await v2AltModel();
        const sa = clampSqrt(sqrtPriceOf(altModel));
        // temporary model over the 8-step walk band to get the walked L / meet target.
        const band0 = await readV3Ticks(ethers.provider, V3_DEEP, 1, spotTick - 40, spotTick + 40);
        const probe0 = concModel(sqrtP, spotTick, 1, band0, 999900n, 1000000n, spotL);
        const ld = await concLegL(h, probe0, sa);
        const { target, dir } = await meetAndDir(h, probe0, altModel, ld);
        // load ticks generously spanning [target, spot] so the swap-to-target crosses every real tick.
        const targetTick = tickAtSqrt(target);
        const lo = Math.min(spotTick, targetTick) - 30, hi = Math.max(spotTick, targetTick) + 30;
        const ticks = await readV3Ticks(ethers.provider, V3_DEEP, 1, lo, hi);
        const defModel = concModel(sqrtP, spotTick, 1, ticks, 999900n, 1000000n, spotL);

        await assertCalibration("V3 defended", h, defModel, altModel, dir, vh, idAddr(V3_DEEP), 6_000_000, targetTick);
    });

    // ---- GATE 2: real V4 defended, skewed, V2 alt ----
    it("CALIBRATION: engine profit matches a real V4 ward within 1% (V4 defended)", async function () {
        this.timeout(600000);
        const { registry, vh, h } = await deployStack();
        const helper = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V2_PANCAKE), V2_KIND, 25, 0]]);
        const cfg = configV4(V4_DEEP);
        const poolId = idV4(V4_DEEP);

        // Skew the V4 pool: dump WBNB in to move its price off the V2 anchor (helper.swapOnce
        // false). This pool's active-tick depth is ~200 WBNB, so a modest dump already crosses
        // several spacing-10 ticks: a genuine multi-tick drive without a degenerate extreme.
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        const amt = 30n * ONE;
        await networkHelpers.setBalance(whale.address, amt + 100n * ONE);
        await wbnb.connect(whale).deposit({ value: amt });
        await wbnb.connect(whale).transfer(await helper.getAddress(), amt);
        await helper.swapOnce(cfg, false, amt);

        // skewed V4 state (extsload)
        const { sqrtP: sRaw, tick: spotTick, liq: spotL } = await readV4Slot0Liq(ethers.provider, poolId);
        const sqrtP = clampSqrt(sRaw);
        const feeNum = 999500n, feeDen = 1000000n; // 0.05%

        const altModel = await v2AltModel();
        // walked L via V4DepthHarness on the REAL config (the V4 read source), then the target.
        const band0 = await readV4Ticks(ethers.provider, poolId, 10, spotTick - 400, spotTick + 400);
        const probe0 = concModel(sqrtP, spotTick, 10, band0, feeNum, feeDen, spotL, cfg);
        const ld = await concLegL(h, probe0, sqrtPriceOf(altModel));
        const { target, dir } = await meetAndDir(h, probe0, altModel, ld);
        const targetTick = tickAtSqrt(target);
        const lo = Math.min(spotTick, targetTick) - 300, hi = Math.max(spotTick, targetTick) + 300;
        const ticks = await readV4Ticks(ethers.provider, poolId, 10, lo, hi);
        const defModel = concModel(sqrtP, spotTick, 10, ticks, feeNum, feeDen, spotL, cfg);

        // This pool's active-tick depth is thin relative to the skew, so the drive provably
        // crosses several real ticks: require >= 2 (see the printed `crossed` count).
        await assertCalibration("V4 defended", h, defModel, altModel, dir, vh, id, 8_000_000, targetTick, 2);
    });
});

// Tick whose sqrtAtTick is <= s < sqrtAtTick(tick+1): the floor tick of a sqrt price, by
// bisection over the ported TickMath (no separate getTickAtSqrtPrice port needed here).
function tickAtSqrt(s) {
    let lo = -887272, hi = 887272;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sqrtAtTick(mid) <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
}
