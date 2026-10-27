import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// End-to-end: a Curve-style stableswap pool as the SINK, driven by a Pancake V3 pool.
// Real BSC pools at block 69832094-1:
//   - PancakeStableSwap USDT/USDC 0x3EFebC... (kind 7, uint256 exchange): the sink
//   - Pancake V3 USDT/USDC 0.01% 0x92b7807...: the flash-capable driver
// The stableswap can't flash, so ward() drives the V3 alt and sinks into the
// stableswap defended. Asserts the safety invariants (no revert, fundless, never a
// loss) and logs the capture, which shows how well the stableswap's tangent depth sizes it.

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const STABLE = "0x3EFebC418efB585248A0D2140cfb87aFcc2C63DD";
const V3_POOL = "0x92b7807bF19b7DDdf89b706143896d05228f3121";
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const KIND_V3 = 2;
const KIND_STABLE = 7;
const ONE = 10n ** 18n;

describeFork("VanHelsing + PancakeStableSwap (Curve-style sink)", function () {
    it("stays safe driving the V3 alt and sinking into a front-run stableswap", async function () {
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: 69832094 - 1 } } });
        const { ethers, networkHelpers } = conn;

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const usdc = await ethers.getContractAt("IERC20", USDC);

        // state each pool's kind and fee directly. V3 first (deep anchor / driver); the
        // stableswap second (the defended sink). The stableswap fee is 1e6 over the 1e10
        // stableswap precision.
        await registry.setPools(USDT, USDC, [
            [idAddr(V3_POOL), KIND_V3, 100, 0],
            [idAddr(STABLE), KIND_STABLE, 1000000, 0],
        ]);

        // front-run the stableswap: dump USDT (USDT->USDC) to shift it off the V3.
        const holder = "0x36696169c63e42cd08ce11f5deebbcebae652050";
        await networkHelpers.impersonateAccount(holder);
        await networkHelpers.setBalance(holder, 100n * ONE);
        const whale = await ethers.getSigner(holder);
        const fr = 200_000n * ONE; // A=1000 is very flat, so a large imbalance is needed
        const stable = new ethers.Contract(
            STABLE,
            ["function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external"],
            whale,
        );
        await usdt.connect(whale).approve(STABLE, fr);
        await stable.exchange(0, 1, fr, 0);
        await networkHelpers.stopImpersonatingAccount(holder);

        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const usdcBefore = await usdc.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(STABLE), BENEFICIARY, { gasLimit: 5_000_000 })).to.not.be.revert(ethers);

        const dUsdt = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore;
        const dUsdc = (await usdc.balanceOf(BENEFICIARY)) - usdcBefore;
        console.log(`  captured: +${ethers.formatUnits(dUsdt, 18)} USDT, +${ethers.formatUnits(dUsdc, 18)} USDC`);

        // fundless: neither beneficiary balance may fall, and nothing is stranded.
        expect(dUsdt >= 0n && dUsdc >= 0n).to.equal(true);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdc.balanceOf(await vh.getAddress())).to.equal(0n);
    });
});
