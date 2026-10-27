import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // USDT/WBNB Pancake V2
const V2_BISWAP = "0x8840C6252e2e86e545deFb6da98B2a0E26d8C1BA";  // USDT/WBNB Biswap
const V3_POOL = "0x172fcd41e0913e95784454622d1c3724f546f849"; // USDT/WBNB V3 (0.01%, deep)
const V3_THIN = "0x6805e0e5333c5c3accf2930be4734e2b98f4ce06"; // USDT/WBNB V3 (1%, thin ~20 WBNB deep)
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const V2_KIND = 0;
const V3_KIND = 2;
const ONE = 10n ** 18n;

describeFork("VanHelsing", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: 67229517 } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function skewV2Wbnb(pair, amount) {
        const p = new ethers.Contract(pair, ["function sync() external"], ethers.provider);
        const [whale] = await ethers.getSigners();
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        await networkHelpers.setBalance(whale.address, amount + 10n * ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await p.connect(whale).sync();
    }

    async function reserves(pair) {
        const p = new ethers.Contract(pair, ["function getReserves() view returns (uint112,uint112,uint32)"], ethers.provider);
        const [r0, r1] = await p.getReserves();
        return [r0, r1];
    }

    async function priceOf(pair) {
        const [r0, r1] = await reserves(pair);
        return (r1 * ONE) / r0;
    }

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });

        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V2_BISWAP), V2_KIND, 20, 0],
        ]);

        return { registry, vh };
    }

    // Same as deployFixture, but the alt is the USDT/WBNB V3 pool instead of
    // Biswap, so ward() has to handle the mixed V2/V3 case. The operator states
    // each pool's kind and fee directly: Pancake V2 at 0.25%, the deep V3 at
    // 0.01% (fee 100).
    async function deployFixtureWithV3() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });

        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V3_POOL), V3_KIND, 100, 0],
        ]);

        return { registry, vh };
    }

    // Register Pancake (defended) plus both alts (Biswap, V3) in a chosen ranked
    // order, so a test can prove selection follows the ranking, not the size.
    async function deployRanked(order) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const inputs = {
            pancake: [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            biswap: [idAddr(V2_BISWAP), V2_KIND, 20, 0],
            v3: [idAddr(V3_POOL), V3_KIND, 100, 0],
        };
        await registry.setPools(USDT, WBNB, order.map((k) => inputs[k]));
        return { registry, vh };
    }
    function deployBiswapFirst() { return deployRanked(["pancake", "biswap", "v3"]); }
    function deployV3First() { return deployRanked(["pancake", "v3", "biswap"]); }

    // ward() and return the anchor recorded in the Captured event.
    async function wardAndAnchor(vh, pool) {
        const tx = await vh["ward(bytes32,address)"](idAddr(pool), BENEFICIARY, { gasLimit: 3_000_000 });
        const rc = await tx.wait();
        for (const log of rc.logs) {
            let ev;
            try { ev = vh.interface.parseLog(log); } catch { continue; }
            if (ev && ev.name === "Captured") return ev.args.anchor;
        }
        return null;
    }

    it("restores the front-run pool and sends the spread to the beneficiary", async function () {
        const { vh } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // simulate a front-run that dumped WBNB into the Pancake pool
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);

        const [, wbnbReserveSkewed] = await reserves(V2_PANCAKE); // WBNB reserve is inflated
        const skewedPrice = await priceOf(V2_PANCAKE);
        const beneUsdtBefore = await usdt.balanceOf(BENEFICIARY);

        // ward() swallows its inner revert, so eth_estimateGas settles on a gas
        // limit where the delegatecall OOGs and is ignored; a real caller
        // supplies the gas as part of its own tx, so we do the same here.
        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        // (a) beneficiary captured USDT profit
        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gt(beneUsdtBefore);

        // (b) the defended pool was restored toward fair: the ward drew WBNB back
        // out of the inflated reserve, so its price fell from the skew.
        const [, wbnbReserveAfter] = await reserves(V2_PANCAKE);
        expect(wbnbReserveAfter).to.be.lt(wbnbReserveSkewed);
        expect(await priceOf(V2_PANCAKE)).to.be.lt(skewedPrice);

        // (c) VanHelsing holds nothing: every flash self-repaid, profit swept
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // ward(id, payee, maxGas) holds the attempt to maxGas, and its caller keeps the rest of the
    // gas: a ward whose cap is too small for the work does nothing, and the transaction goes on.
    it("with a gas cap too small for the work, does nothing and leaves its caller the rest", async function () {
        const { vh } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const beneBefore = await usdt.balanceOf(BENEFICIARY);
        const priceBefore = await priceOf(V2_PANCAKE);

        const tx = await vh["ward(bytes32,address,uint256)"](idAddr(V2_PANCAKE), BENEFICIARY, 30_000, { gasLimit: 3_000_000 });
        const rc = await tx.wait();

        expect(rc.status).to.equal(1);
        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(beneBefore);
        expect(await priceOf(V2_PANCAKE)).to.equal(priceBefore);
        expect(rc.gasUsed).to.be.lt(21_000n + 30_000n + 15_000n); // the transaction, the capped attempt, the wrapper
    });

    it("with a gas cap that leaves room for the work, captures what the plain ward does", async function () {
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const captured = async (send) => {
            const { vh } = await loadFixture(deployFixture);
            await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
            const before = await usdt.balanceOf(BENEFICIARY);
            await (await send(vh)).wait();
            return (await usdt.balanceOf(BENEFICIARY)) - before;
        };
        const plain = await captured((vh) => vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 }));
        const capped = await captured((vh) => vh["ward(bytes32,address,uint256)"](idAddr(V2_PANCAKE), BENEFICIARY, 1_000_000, { gasLimit: 3_000_000 }));

        expect(plain).to.be.gt(0n);
        expect(capped).to.equal(plain);
    });

    it("V2/V2: flashes the blue chip so the spread is captured in it", async function () {
        const { vh } = await loadFixture(deployFixture); // Pancake V2 + Biswap V2
        const registry = await ethers.getContractAt("PoolRegistryHarness", await vh.REGISTRY());
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // default pays in USDT (t0); rank WBNB so the circular flash borrows WBNB
        // and the spread is captured in WBNB instead (the equivalent B->A->B cycle).
        await registry.setToken(WBNB, 100, 0);
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        expect(await wbnb.balanceOf(BENEFICIARY)).to.be.gt(wbnbBefore);
        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(usdtBefore);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("skips a restore whose profit is below the token's per-token dust floor", async function () {
        const { vh, registry } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);

        // an absurd USDT dust floor the captured spread can never clear
        await registry.setToken(USDT, 0, 10n ** 30n);
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const before = await usdt.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        // below floor -> swallowed no-op: nothing swept, nothing stranded
        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(before);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // Mixed-kind (one V2, one V3): execute() sizes from the fee-adjusted meeting
    // price and always drives the DEFENDED pool to its final via flash (a V2 flash
    // here), sinking the output into the alt (V3), which reaches its own final by
    // absorbing the flow. With no virtual reserves, a V3 tick extreme cannot break
    // the sizing. The front-run direction fixes the default payout token: dumping
    // WBNB into V2 drives it back down (WBNB out, USDT owed) and pays in USDT;
    // dumping USDT drives it back up and pays in WBNB. A registry blue-chip
    // preference overrides this (see the exact-output test below).

    it("captures a mixed-kind front-run: drives the V2 defended, sinks the V3 alt", async function () {
        const { vh } = await loadFixture(deployFixtureWithV3);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // front-run dumped WBNB into V2, so its price is too high (WBNB cheap vs V3)
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const [, wbnbReserveSkewed] = await reserves(V2_PANCAKE);
        const before = await usdt.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        // (a) captured the spread (in USDT this direction: WBNB flashed out, USDT owed)
        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gt(before);
        // (b) V2 restored: driving it down drew its inflated WBNB reserve toward fair
        const [, wbnbReserveAfter] = await reserves(V2_PANCAKE);
        expect(wbnbReserveAfter).to.be.lt(wbnbReserveSkewed);
        // (c) fundless: every flash self-repaid, nothing stranded on either leg
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("captures the reverse direction, where V2 is too cheap and the bounty is paid in WBNB", async function () {
        const { vh } = await loadFixture(deployFixtureWithV3);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // dump USDT into V2 so its price is too low; driving it back up flashes USDT
        // out, sinks it into V3 for WBNB, and repays WBNB, so the spread lands in WBNB.
        const p = new ethers.Contract(V2_PANCAKE, ["function sync() external"], ethers.provider);
        const holder = "0x36696169c63e42cd08ce11f5deebbcebae652050"; // USDT whale
        await networkHelpers.impersonateAccount(holder);
        await networkHelpers.setBalance(holder, 10n * ONE);
        const signer = await ethers.getSigner(holder);
        await usdt.connect(signer).transfer(V2_PANCAKE, 500_000n * ONE);
        await networkHelpers.stopImpersonatingAccount(holder);
        await p.connect((await ethers.getSigners())[0]).sync();

        const before = await wbnb.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        expect(await wbnb.balanceOf(BENEFICIARY)).to.be.gt(before);
        // fundless in both legs: nothing stranded on either side
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("pays the bounty in the registry's blue-chip token (exact-output flips the leg)", async function () {
        const { vh } = await loadFixture(deployFixtureWithV3);
        const registry = await ethers.getContractAt("PoolRegistryHarness", await vh.REGISTRY());
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // this front-run direction pays in WBNB by default (see the mixed-kind
        // test); rank USDT as the blue chip so the spread lands in USDT instead,
        // via an exact-output sink sale rather than exact-input.
        await registry.setToken(USDT, 100, 0);
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 });

        // spread now captured in USDT (the blue chip), not WBNB
        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gt(usdtBefore);
        expect(await wbnb.balanceOf(BENEFICIARY)).to.equal(wbnbBefore);
        // still fundless
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // Degradation: ward() must never revert its caller and must leave nothing
    // behind, whatever the reason execute() cannot find or complete an arb.

    it("is a no-op and never reverts on an unregistered defended pool", async function () {
        const { vh } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const beneBefore = await usdt.balanceOf(BENEFICIARY);

        // never registered: wardPools() reports ok=false, so execute() reverts
        // UNREGISTERED inside the swallowed delegatecall.
        const RANDOM = "0x0000000000000000000000000000000000001234";
        await expect(vh["ward(bytes32,address)"](idAddr(RANDOM), BENEFICIARY, { gasLimit: 3_000_000 })).to.not.be.revert(ethers);

        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(beneBefore);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("is a no-op when a registered pool has no dislocation", async function () {
        const { vh } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const beneBefore = await usdt.balanceOf(BENEFICIARY);

        // no skew: the registered pools are near fair, so the fee check finds no
        // profitable direction and execute() reverts NO_ARB behind the swallow.
        await expect(vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 })).to.not.be.revert(ethers);

        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(beneBefore);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("is a no-op when the pair has only the defended pool registered", async function () {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        await registry.setPools(USDT, WBNB, [[idAddr(V2_PANCAKE), V2_KIND, 25, 0]]);

        // even with a real dislocation, a pool alone in its list has no anchor to
        // pair against, so it no-ops.
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const beneBefore = await usdt.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 })).to.not.be.revert(ethers);

        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(beneBefore);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // Both pools shoved to the SAME price: extremely dislocated from the true
    // market, but in agreement with each other, so there is no relative arb to
    // capture. This is the co-manipulation case: ward must read the small
    // relative gap, find nothing profitable, and no-op cleanly. Reserves are set
    // directly (transfer + sync, no swap slippage), so both spot prices land on the
    // target exactly and the residual gap is sub-fee. Snapshot-isolated: it skews
    // the shared Biswap pool, whose leak would change the ranking test's arb.
    it("no-ops when both pools are co-manipulated to the same price", async function () {
        const snap = await networkHelpers.takeSnapshot();

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V2_BISWAP), V2_KIND, 20, 0],
        ]);

        const [r0P, r1P] = await reserves(V2_PANCAKE);
        const [r0B, r1B] = await reserves(V2_BISWAP);
        const pP = (r1P * ONE) / r0P;
        const pB = (r1B * ONE) / r0B;
        const target = (13n * (pP > pB ? pP : pB)) / 10n; // 1.3x above both -> both move up together
        await skewV2Wbnb(V2_PANCAKE, (target * r0P) / ONE - r1P);
        await skewV2Wbnb(V2_BISWAP, (target * r0B) / ONE - r1B);

        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 3_000_000 })).to.not.be.revert(ethers);

        // both at ~the same price => NO_ARB => nothing captured or stranded
        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(usdtBefore);
        expect(await wbnb.balanceOf(BENEFICIARY)).to.equal(wbnbBefore);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        await snap.restore();
    });

    // Reentrancy: the only untrusted re-entry vector is a registered pool's
    // swap() during a real arb. A malicious pool, registered like any other,
    // re-enters execute() there; the transient lock must revert that nested
    // call. We route a genuine flash through the malicious pool as the flash
    // source, have it record the lock's revert, then hand back a fixed profit
    // so the outer execute() commits and the record survives.
    it("blocks a registered pool that re-enters execute() during the arb", async function () {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        // malicious pool priced with 4x the WBNB reserve of Pancake, so WBNB is
        // ~4x cheaper there; warded, it is the pool VanHelsing flash-drives.
        const [r0Real, r1Real] = await reserves(V2_PANCAKE); // (USDT, WBNB)
        const GIFT = ONE; // 1 USDT of "profit" so the outer execute() commits
        const rp = await deploy(conn, "ReentrantPool", null, [
            await vh.getAddress(), USDT, WBNB, r0Real, r1Real * 4n, GIFT,
        ]);

        // register the real Pancake pool plus the malicious ReentrantPool directly,
        // stating each as a V2 pool at 0.25%: no factory, no on-chain validation.
        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(await rp.getAddress()), V2_KIND, 25, 0],
        ]);

        // fund the pool with USDT so it can hand back the gift.
        const holder = "0x36696169c63e42cd08ce11f5deebbcebae652050";
        await networkHelpers.impersonateAccount(holder);
        await networkHelpers.setBalance(holder, 10n * ONE);
        await usdt.connect(await ethers.getSigner(holder)).transfer(await rp.getAddress(), 10n * ONE);
        await networkHelpers.stopImpersonatingAccount(holder);

        const beneBefore = await usdt.balanceOf(BENEFICIARY);

        // ward routes the flash through rp; rp.swap re-enters execute(), the lock
        // reverts that nested call, rp records it and completes the outer arb.
        await expect(vh["ward(bytes32,address)"](idAddr(await rp.getAddress()), BENEFICIARY, { gasLimit: 3_000_000 })).to.not.be.revert(ethers);

        // the lock fired on the nested execute() (set only on a "REENTRANCY" revert).
        expect(await rp.reentryBlocked()).to.equal(true);
        // the outer arb committed: the gift was swept to the beneficiary and
        // nothing was stranded in VanHelsing.
        expect(await usdt.balanceOf(BENEFICIARY)).to.equal(beneBefore + GIFT);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // A V3 defended pool is restored from its marginal price via swap-to-limit,
    // not from virtual reserves (which blow up at an extreme tick). Front-run the
    // thin 1% V3 pool (~20 WBNB deep) to shove its price far off fair, then ward
    // it with the deep V2 Pancake pool as the restore anchor. The anchor is deeper
    // than the defended pool, so restoring to its price does not overshoot.
    // Snapshot-isolated so the front-run does not leak into other fixtures.
    it("restores a thin V3 defended pool a front-run dislocated", async function () {
        const snap = await networkHelpers.takeSnapshot();

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const poker = await deploy(conn, "PoolPoker");

        // Most-liquid first: deep V2 Pancake is the restore anchor; the thin 1% V3
        // pool is the defended venue that gets restored.
        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V3_THIN), V3_KIND, 10000, 0],
        ]);

        // front-run: dump WBNB into the thin V3 pool (WBNB -> USDT) to push its
        // price far past fair. USDT's virtual reserve collapses, the exact case
        // that would break a closed-form sizer on virtual reserves.
        const [whale] = await ethers.getSigners();
        const fr = 30n * ONE;
        await networkHelpers.setBalance(whale.address, fr + 100n * ONE);
        await wbnb.connect(whale).deposit({ value: fr });
        await wbnb.connect(whale).transfer(await poker.getAddress(), fr);
        await poker.poke(V3_THIN, false, fr);

        const before = await usdt.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](idAddr(V3_THIN), BENEFICIARY, { gasLimit: 5_000_000 });

        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gt(before); // captured spread
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n); // fundless
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        await snap.restore();
    });

    // Both legs V3: the sink's swap runs inside the driven pool's callback and calls
    // back through the same fallback, so the callback context must switch to the sink
    // around it; otherwise the alt pool's own swap callback would land in the drive
    // handler instead of the sink's. Defended = thin 1% V3; anchor = deep 0.01% V3.
    it("restores a thin V3 pool against a deep V3 alt (both legs V3)", async function () {
        const snap = await networkHelpers.takeSnapshot();

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const poker = await deploy(conn, "PoolPoker");

        // Deep 0.01% V3 is the anchor; the thin 1% V3 is the defended venue.
        await registry.setPools(USDT, WBNB, [
            [idAddr(V3_POOL), V3_KIND, 100, 0],
            [idAddr(V3_THIN), V3_KIND, 10000, 0],
        ]);

        const [whale] = await ethers.getSigners();
        const fr = 30n * ONE;
        await networkHelpers.setBalance(whale.address, fr + 100n * ONE);
        await wbnb.connect(whale).deposit({ value: fr });
        await wbnb.connect(whale).transfer(await poker.getAddress(), fr);
        await poker.poke(V3_THIN, false, fr);

        const before = await usdt.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](idAddr(V3_THIN), BENEFICIARY, { gasLimit: 5_000_000 });

        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gt(before); // captured spread
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n); // fundless
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        await snap.restore();
    });

    // The same thin V3 defended pool against the deep V2 anchor, front-run the OTHER
    // direction (USDT dumped in, not WBNB), so the drive-the-V3 restore runs the
    // opposite sign. Confirms the V3-defended path is symmetric: a front-run that
    // moves the price either way is captured and restored, never a loss.
    it("restores a thin V3 defended pool front-run the other direction", async function () {
        const snap = await networkHelpers.takeSnapshot();

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const poker = await deploy(conn, "PoolPoker");

        // deep V2 Pancake is the anchor; the thin 1% V3 is the defended venue.
        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V3_THIN), V3_KIND, 10000, 0],
        ]);

        // front-run the OTHER way: dump USDT into the thin V3 (USDT -> WBNB), pushing
        // its price past fair opposite to the WBNB-dump case.
        const holder = "0x36696169c63e42cd08ce11f5deebbcebae652050"; // USDT whale
        await networkHelpers.impersonateAccount(holder);
        await networkHelpers.setBalance(holder, 10n * ONE);
        const fr = 50_000n * ONE;
        await usdt.connect(await ethers.getSigner(holder)).transfer(await poker.getAddress(), fr);
        await networkHelpers.stopImpersonatingAccount(holder);

        await poker.poke(V3_THIN, true, fr); // zeroForOne: USDT -> WBNB, the opposite sign from the WBNB dump

        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(V3_THIN), BENEFICIARY, { gasLimit: 5_000_000 })).to.not.be.revert(ethers);

        // fundless: neither beneficiary balance can fall; and the arb captured the
        // spread in one of the two tokens (which one is fixed by this direction).
        const usdtAfter = await usdt.balanceOf(BENEFICIARY);
        const wbnbAfter = await wbnb.balanceOf(BENEFICIARY);
        expect(usdtAfter >= usdtBefore && wbnbAfter >= wbnbBefore).to.equal(true);
        expect(usdtAfter > usdtBefore || wbnbAfter > wbnbBefore).to.equal(true);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        await snap.restore();
    });

    // The anchor at an extreme price: the ALT (reference) is the pool shoved far off
    // fair, the defended is fair. ward brings the dislocated V3 alt back toward the
    // deep V2: the depth walk reads the alt's real liquidity at its extreme price,
    // not a thin active tick. Captures the alt's dislocation and stays fundless.
    it("captures when the anchor is the pool pushed to an extreme price", async function () {
        const snap = await networkHelpers.takeSnapshot();

        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const poker = await deploy(conn, "PoolPoker");

        // deep V2 Pancake is the defended (fair) venue; the thin 1% V3 is the alt.
        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V3_THIN), V3_KIND, 10000, 0],
        ]);

        // shove the ALT far off fair (dump WBNB into the thin V3); Pancake stays fair.
        const [whale] = await ethers.getSigners();
        const fr = 30n * ONE;
        await networkHelpers.setBalance(whale.address, fr + 100n * ONE);
        await wbnb.connect(whale).deposit({ value: fr });
        await wbnb.connect(whale).transfer(await poker.getAddress(), fr);
        await poker.poke(V3_THIN, false, fr);

        // ward the FAIR defended pool; the dislocation lives on the alt.
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);
        await expect(vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 5_000_000 })).to.not.be.revert(ethers);

        const usdtAfter = await usdt.balanceOf(BENEFICIARY);
        const wbnbAfter = await wbnb.balanceOf(BENEFICIARY);
        expect(usdtAfter >= usdtBefore && wbnbAfter >= wbnbBefore).to.equal(true); // fundless
        expect(usdtAfter > usdtBefore || wbnbAfter > wbnbBefore).to.equal(true); // captured
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);

        await snap.restore();
    });

    // Keep this LAST: it skews the shared Pancake pool before its fixtures are
    // first snapshotted, so running it earlier would bake the skew into
    // deployFixture's snapshot and break the exact-equality no-dislocation test.
    it("uses the top-ranked alt, not a lower one", async function () {
        // Selection takes the top (most-liquid) non-defended pool, full stop.
        // Both alts here are profitable against a WBNB-skewed Pancake, so the one
        // ranked first is the one used, and flipping the ranking flips the choice.
        let { vh } = await loadFixture(deployBiswapFirst);
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        expect(await wardAndAnchor(vh, V2_PANCAKE)).to.equal(idAddr(V2_BISWAP));

        ({ vh } = await loadFixture(deployV3First));
        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        expect(await wardAndAnchor(vh, V2_PANCAKE)).to.equal(idAddr(V3_POOL));
    });
});
