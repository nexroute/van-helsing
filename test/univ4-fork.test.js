import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4, registerV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NATIVE = "0x0000000000000000000000000000000000000000";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Uniswap V4 WBNB/USDT pools on BSC (currency0 = USDT, currency1 = WBNB, no hooks),
// located by brute-forcing standard fee/tickSpacing tiers against the singleton.
// meta = [kind, currency0, currency1, fee, tickSpacing, hooks, parameters].
const V4_DEEP = [4, USDT, WBNB, 500, 10, NO_HOOKS, ZH]; // 0.05%, deep WBNB/USDT (aligned)
// Native-BNB/USDT V4 pool (currency0 = native address(0), currency1 = USDT). Maps to the
// same USDT/WBNB ERC20 pair, but native sorts to currency0 while WBNB sorts to token1,
// so it is FLIPPED (inverted sqrtPrice, reversed swap directions).
const V4_NATIVE = [4, NATIVE, USDT, 500, 10, NO_HOOKS, ZH];
// The packed config bytes the harness/registry take (the meta arrays above still feed
// idV4/registerV4, which key by the poolId hash).
const CFG_DEEP = configV4(V4_DEEP);
const CFG_NATIVE = configV4(V4_NATIVE);
// Established Pancake USDT/WBNB pools for the mixed-kind cases.
const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849"; // Pancake V3 0.01%
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // Pancake V2
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const BLOCK = 103808000;
const ONE = 10n ** 18n;

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

describeFork("VanHelsing + Uniswap V4", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        // One shared fork: the singleton's cold storage reads are fetched once and
        // cached across every test (each test reverts to the post-deploy snapshot).
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const helper = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } }); // front-runs + reads V4 pools
        const holder = await deploy(conn, "LockHolder", null, [], { libraries: { UniV4Lib: null, InfinityLib: null } }); // calls ward inside its own lock
        return { registry, vh, helper, holder };
    }

    async function fundWbnb(to, amount) {
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(to, amount);
    }

    // Front-run a V4 pool: fund `helper` with WBNB and swap it for USDT (!zeroForOne),
    // pushing the pool's price up and dislocating it.
    async function skewV4WithWbnb(helper, cfg, amount) {
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(await helper.getAddress(), amount);
        await helper.swapOnce(cfg, false, amount);
    }

    // Front-run a V2 pool: dump WBNB straight into it and sync.
    async function skewV2Wbnb(pair, amount) {
        const p = new ethers.Contract(pair, ["function sync() external"], ethers.provider);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await p.connect(whale).sync();
    }

    it("normalizes a real Uni V4 pool: sqrtPrice and liquidity are live and sane", async function () {
        const { registry, helper } = await loadFixture(deployFixture);
        const [s, l] = await helper.normalize(CFG_DEEP);
        expect(l).to.be.gt(0n);
        expect(s).to.be.gt(MIN_SQRT);
        expect(s).to.be.lt(MAX_SQRT);

        // the poolId UniV4Lib derives equals the JS-computed one we key and ward by
        expect(await helper.idOf(CFG_DEEP)).to.equal(idV4(V4_DEEP));
    });

    it("locks the manager, swaps, takes the output, and settles the debt", async function () {
        const { helper } = await loadFixture(deployFixture);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const [sBefore] = await helper.normalize(CFG_DEEP);

        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, 2n * ONE);
        await wbnb.connect(whale).deposit({ value: ONE });
        await wbnb.connect(whale).transfer(await helper.getAddress(), ONE);

        const amountOut = await helper.swapOnce.staticCall(CFG_DEEP, false, ONE);
        await helper.swapOnce(CFG_DEEP, false, ONE);

        expect(amountOut).to.be.gt(100n * ONE); // ~1 WBNB fetches a few hundred USDT
        expect(amountOut).to.be.lt(5000n * ONE);
        expect(await usdt.balanceOf(await helper.getAddress())).to.equal(amountOut);
        expect(await wbnb.balanceOf(await helper.getAddress())).to.equal(0n);
        const [sAfter] = await helper.normalize(CFG_DEEP);
        expect(sAfter).to.be.gt(sBefore); // one-for-zero raises the price
    });

    it("drives a dislocated V4 pool and sinks into the V3 alt", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await skewV4WithWbnb(helper, CFG_DEEP, 400n * ONE);
        const [sSkewed] = await helper.normalize(CFG_DEEP);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 6_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_DEEP);
        expect(sAfter).to.be.lt(sSkewed); // restored back toward fair
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("drives a dislocated V2 pool and sinks into the V4 alt (nested lock)", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        // defended Pancake V2, deep V4 as the fair alt/sink
        await registry.setPools(USDT, WBNB, [[idAddr(V2_PANCAKE), 0, 25, 0], [id, 4, 500, 0]]);

        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 6_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("drives a dislocated native-BNB/USDT V4 pool (flipped driver) and sinks into the V3 alt", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_NATIVE);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await skewV4WithWbnb(helper, CFG_NATIVE, 300n * ONE); // dislocate the flipped pool
        const [sSkewed] = await helper.normalize(CFG_NATIVE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_NATIVE);
        expect(sAfter).to.be.lt(sSkewed); // the skew raised the token-space price; restored down
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });

    it("restores a WBNB/USDT V4 pool against a deep native-BNB/USDT V4 alt (both V4, one lock, flip + native)", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const idNative = await registerV4(registry, V4_NATIVE);
        const idWbnb = await registerV4(registry, V4_DEEP);
        // deep native pool is the anchor; the WBNB pool is the defended venue. Both map
        // to the USDT/WBNB pair. Driving the (aligned) WBNB pool and sinking into the
        // (flipped) native pool inside one lock exercises the flip + native wrap/unwrap.
        await registry.setPools(USDT, WBNB, [[idNative, 4, 500, 0], [idWbnb, 4, 500, 0]]);

        await skewV4WithWbnb(helper, CFG_DEEP, 400n * ONE);
        const [sSkewed] = await helper.normalize(CFG_DEEP);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idWbnb, BENEFICIARY, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_DEEP);
        expect(sAfter).to.be.lt(sSkewed); // the defended WBNB pool restored toward fair
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n); // no stranded native
    });

    // ward(id, payee) restores the pool against the most liquid other pool the registry lists for
    // its pair: the first one listed after the warded pool.
    it("wards against the pair's most liquid other pool", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0], [idAddr(V2_PANCAKE), 0, 25, 0]]);

        await skewV4WithWbnb(helper, CFG_DEEP, 400n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        const rc = await (await vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 6_000_000 })).wait();

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const captured = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
        expect(captured).to.have.length(1);
        expect(captured[0].args.anchor).to.equal(idAddr(V3_DEEP)); // ranked first after the warded pool
    });

    // A v4 hook, or a router's unlock callback, calls ward while the PoolManager's lock is
    // already open: the ward trades inside that lock instead of opening its own.
    it("wards a dislocated V4 pool from inside a lock someone else holds", async function () {
        const { registry, vh, helper, holder } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await skewV4WithWbnb(helper, CFG_DEEP, 400n * ONE);
        const [sSkewed] = await helper.normalize(CFG_DEEP);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await holder.wardInV4Lock(await vh.getAddress(), id, BENEFICIARY, CFG_DEEP, false, 0n, { gasLimit: 6_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_DEEP);
        expect(sAfter).to.be.lt(sSkewed); // restored back toward fair
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("captures the back-run of a swap made earlier in the same open lock, each side settling its own", async function () {
        const { registry, vh, holder } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await fundWbnb(await holder.getAddress(), 400n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        // the holder swaps 400 WBNB on the V4 pool, then wards it, all in one unlock
        await holder.wardInV4Lock(await vh.getAddress(), id, BENEFICIARY, CFG_DEEP, false, 400n * ONE, { gasLimit: 6_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        expect(await usdt.balanceOf(await holder.getAddress())).to.be.gt(0n); // the swap's output is the holder's
        expect(await wbnb.balanceOf(await holder.getAddress())).to.equal(0n); // and its input was paid
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("sinks into the V4 alt from inside an open lock (V2 driver)", async function () {
        const { registry, vh, holder } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[idAddr(V2_PANCAKE), 0, 25, 0], [id, 4, 500, 0]]);

        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await holder.wardInV4Lock(await vh.getAddress(), idAddr(V2_PANCAKE), BENEFICIARY, CFG_DEEP, false, 0n, { gasLimit: 6_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    it("no-ops (no revert) when the V4 pool is not dislocated", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);

        const id = await registerV4(registry, V4_DEEP);
        await registry.setPools(USDT, WBNB, [[id, 4, 500, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        const before = await usdt.balanceOf(BENEFICIARY);
        await vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 6_000_000 }); // in-line with V3, no meaningful spread
        // no capture beyond dust, and nothing stranded
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdt.balanceOf(BENEFICIARY)).to.be.gte(before);
    });
});
