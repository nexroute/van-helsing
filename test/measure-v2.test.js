import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { v2Out, v2Model, swapOut, profit, goldenMax, sqrtPriceOf, liquidityOf } from "./lib/pool-model.js";
import { captureFraction } from "./lib/capture.js";

const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";

describe("pool-model engine (V2)", function () {
    it("v2Out matches the closed-form and swapOut dispatches", function () {
        const out = v2Out(10n * ONE, 1000n * ONE, 1000n * ONE, 9975n, 10000n);
        expect(out).to.equal(9876482091140869823n); // 0.25% fee, precomputed
        const m = v2Model(1000n * ONE, 1000n * ONE);
        expect(swapOut(m, 10n * ONE, true)).to.equal(out);
    });

    it("profit is unimodal and goldenMax finds the arb optimum", function () {
        // defended has token1 scarce (r1 << r0), alt at fair 1:1, so an arb exists. t1 is
        // scarce/expensive in def, so the profitable drive spends t1 into def (dir=false,
        // buying the cheap t0) and sinks the t0 into alt.
        const def = v2Model(4000n * ONE, 1000n * ONE); // t1 scarce/expensive in def
        const alt = v2Model(1000n * ONE, 1000n * ONE);
        const best = goldenMax((a) => profit(def, alt, a, false), 1n, 999n * ONE);
        expect(best.y).to.be.gt(0n);
        // profit at the optimum exceeds profit at half and double the size
        expect(profit(def, alt, best.x, false)).to.be.gte(profit(def, alt, best.x / 2n, false));
        expect(profit(def, alt, best.x, false)).to.be.gte(profit(def, alt, best.x * 2n, false));
    });

    // CALIBRATION: deploy a real MockV2Pool defended+alt trio, register them, run a real
    // vh.ward, and check the engine's profit(VanHelsing's chosen size) against the
    // beneficiary's realized gain. This validates BOTH the V2 swap math (v2Out matches
    // V2Lib.amountOut exactly, checked above) AND the vanHelsingDriveSize derivation (the
    // shipped MeetingPrice.meet plus the drive-to-target closed form), together, against a
    // real execution: the load-bearing gate the rest of the capture suite rests on.
    it("CALIBRATION: engine profit matches a real MockV2Pool ward (V2/V2)", async function () {
        const conn = await network.create({ network: "hardhat" });
        const ethers = conn.ethers;
        const [me] = await ethers.getSigners();

        async function mkToken(sym) { return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]); }
        async function mkPool(x, y, rx, ry, feeNum = 9975n) {
            const ax = (await x.getAddress()).toLowerCase(), ay = (await y.getAddress()).toLowerCase();
            const [t0, t1, r0, r1] = ax < ay ? [x, y, rx, ry] : [y, x, ry, rx];
            const pool = await deploy(conn, "MockV2Pool", null, [await t0.getAddress(), await t1.getAddress(), feeNum, 10000n]);
            await t0.mint(me.address, r0); await t1.mint(me.address, r1);
            await t0.approve(await pool.getAddress(), r0); await t1.approve(await pool.getAddress(), r1);
            await pool.initReserves(r0, r1);
            return pool;
        }

        const registry = await deploy(conn, "PoolRegistryHarness");
        // Order matters: deploy() links libraries in map order, and RouteLib itself needs
        // V3Depth/V4Depth resolved first (see contract.js's getFactory), so they must be
        // listed ahead of RouteLib here (matches route-v2.test.js's setup()).
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], {
            libraries: {
                CurveLib: null, UniV4Lib: null, InfinityLib: null,
                V3Depth: null, V4Depth: null, RouteLib: null,
            },
        });
        const mp = await deploy(conn, "MeetingPriceHarness");

        const A = await mkToken("A"), X = await mkToken("X");
        // defended: X over-supplied 4x (cheap); alt: fair 1:1. Same dislocation shape
        // route-v2.test.js uses for its V2 triangular-route cases.
        const defended = await mkPool(A, X, 1000n * ONE, 4000n * ONE);
        const alt = await mkPool(A, X, 1000n * ONE, 1000n * ONE);

        const defId = idAddr(await defended.getAddress());
        const altId = idAddr(await alt.getAddress());
        await registry.setPools(await A.getAddress(), await X.getAddress(), [[defId, 0, 25, 0], [altId, 0, 25, 0]]);

        // Build the engine's models from the pools' actual sorted reserves: don't assume
        // which of A/X sorts as token0, read it back.
        const [dr0, dr1] = await defended.getReserves();
        const [ar0, ar1] = await alt.getReserves();
        const defModel = v2Model(dr0, dr1);
        const altModel = v2Model(ar0, ar1);
        const h = { mp };

        // Direction follows VanHelsing's _pickDriver exactly: zeroForOne = the defended's
        // current price is above the meet target (drive by adding token0 to lower it).
        const [sdF] = await mp.meetBoth(
            sqrtPriceOf(defModel), liquidityOf(defModel), defModel.feeNum, defModel.feeDen,
            sqrtPriceOf(altModel), liquidityOf(altModel), altModel.feeNum, altModel.feeDen,
        );
        const dir = sqrtPriceOf(defModel) > sdF;

        const { capture, chosenProfit, optimalProfit, chosen } = await captureFraction(h, defModel, altModel, dir);
        expect(chosenProfit).to.be.gt(0n);

        // The realized profit token: _payout's base = (zeroForOne == exactOut) ? t1 : t0.
        // No token priorities are registered here, so exactOut is always false, and base
        // reduces to the drive-input token: exactly what profit() above is denominated
        // in, so the two numbers are directly comparable.
        const baseToken = dir ? await defended.token0() : await defended.token1();
        const baseIsA = baseToken.toLowerCase() === (await A.getAddress()).toLowerCase();
        const baseC = baseIsA ? A : X;

        const beneBefore = await baseC.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](defId, BENEFICIARY, { gasLimit: 6_000_000 });
        const realized = (await baseC.balanceOf(BENEFICIARY)) - beneBefore;

        const delta = chosenProfit > realized ? chosenProfit - realized : realized - chosenProfit;
        expect(delta, `engine ${chosenProfit} vs realized ${realized}`).to.be.lte(100n);
        expect(capture).to.be.within(0, 1);
        console.log(`  [V2/V2 calibration] capture=${(capture * 100).toFixed(2)}% engine=${chosenProfit} realized=${realized} optimal=${optimalProfit} chosenSize=${chosen}`);
    });
});
