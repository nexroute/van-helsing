import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../../lib/contract.js";
import { idAddr, idV4, configV4, registerV4 } from "../helpers/ids.js";
import { describeRobinhood } from "../helpers/fork.js";

// Van Helsing built for Robinhood Chain (VH_CHAIN=robinhood) on a fork of it, against its own
// Uniswap pools for WETH/USDG (USDG is Paxos' dollar, 6 decimals).
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Uniswap v4 ETH/USDG pools without hooks. Native ETH is currency0, and WETH, which stands for it
// in the pair, sorts before USDG too, so the pools are aligned with the pair.
// meta = [kind, currency0, currency1, fee, tickSpacing, hooks, parameters].
const V4_100 = [4, NATIVE, USDG, 100, 1, NO_HOOKS, ZH]; // 0.01%
const V4_500 = [4, NATIVE, USDG, 500, 10, NO_HOOKS, ZH]; // 0.05%
const CFG_100 = configV4(V4_100);
// Uniswap v3 WETH/USDG pools: the 0.01% one is the deepest WETH/USDG pool on the chain.
const V3_100 = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
const V3_500 = "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a";

const PAYEE = "0x00000000000000000000000000000000beC0ffEE";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const ONE = 10n ** 18n;

describeRobinhood("Van Helsing on Robinhood Chain (Uniswap v4 and v3)", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        expect((await ethers.provider.getNetwork()).chainId).to.equal(4663n);
    });

    // VanHelsing behind its proxy, as deployed.
    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], {
            libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null },
            proxy: true,
        });
        const helper = await deploy(conn, "UniV4LibHarness", null, [], { libraries: { UniV4Lib: null } });
        const holder = await deploy(conn, "LockHolder", null, [], { libraries: { UniV4Lib: null, InfinityLib: null } });
        const poker = await deploy(conn, "PoolPoker");
        return { registry, vh, helper, holder, poker };
    }

    async function fundWeth(to, amount) {
        const weth = await ethers.getContractAt("IWETH", WETH);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await weth.connect(whale).deposit({ value: amount });
        await weth.connect(whale).transfer(to, amount);
    }

    // What `who` holds of the pair, and what VanHelsing kept (it must keep nothing).
    async function holdings(who) {
        const weth = await ethers.getContractAt("IERC20", WETH);
        const usdg = await ethers.getContractAt("IERC20", USDG);
        return { weth: await weth.balanceOf(who), usdg: await usdg.balanceOf(who) };
    }
    async function expectNothingKept(vh) {
        const kept = await holdings(await vh.getAddress());
        expect(kept.weth).to.equal(0n);
        expect(kept.usdg).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    }

    // The one Captured event of a ward, and the split it paid: the payee all of it but CUT_BPS,
    // which went to the treasury.
    async function expectCaptured(vh, rc, pool, anchor, before) {
        const events = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
        expect(events).to.have.length(1);
        const { args } = events[0];
        expect(args.pool).to.equal(pool);
        expect(args.anchor).to.equal(anchor);
        expect(args.payee).to.equal(ethers.getAddress(PAYEE));
        expect(args.bounty).to.be.gt(0n);
        const cut = args.bounty * 1_000n / 10_000n;
        const key = ethers.getAddress(args.token) === ethers.getAddress(WETH) ? "weth" : "usdg";
        expect((await holdings(TREASURY))[key] - before.treasury[key]).to.equal(cut);
        expect((await holdings(PAYEE))[key] - before.payee[key]).to.equal(args.bounty - cut);
        return args;
    }
    const snapshot = async () => ({ payee: await holdings(PAYEE), treasury: await holdings(TREASURY) });

    it("is built for Robinhood Chain: it reads an ETH/USDG pool of the chain's own PoolManager", async function () {
        const { helper } = await networkHelpers.loadFixture(deployFixture);
        expect(await ethers.provider.getCode(POOL_MANAGER)).to.not.equal("0x");
        expect(await helper.idOf(CFG_100)).to.equal(idV4(V4_100));
        const [s, l] = await helper.normalize(CFG_100);
        expect(l).to.be.gt(0n);
        // t1/t0 in raw units is USDG (6 decimals) per WETH (18): an ETH price, in dollars, far
        // from any bound
        const usdPerEth = (Number(s) / 2 ** 96) ** 2 * 1e12;
        expect(usdPerEth).to.be.within(100, 100_000);
    });

    it("swaps in the PoolManager, paying the native ETH it owes from WETH", async function () {
        const { helper } = await networkHelpers.loadFixture(deployFixture);
        await fundWeth(await helper.getAddress(), ONE);
        const out = await helper.swapOnce.staticCall(CFG_100, true, ONE);
        await helper.swapOnce(CFG_100, true, ONE);
        expect(out).to.be.within(100n * 10n ** 6n, 100_000n * 10n ** 6n); // dollars for 1 ETH
        const after = await holdings(await helper.getAddress());
        expect(after.usdg).to.equal(out);
        expect(after.weth).to.equal(0n);
    });

    it("wards a dislocated v4 pool against the deep v3 pool", async function () {
        const { registry, vh, helper } = await networkHelpers.loadFixture(deployFixture);
        const id = await registerV4(registry, V4_100);
        await registry.setPools(WETH, USDG, [[idAddr(V3_100), 2, 100, 0], [id, 4, 100, 0]]);

        await fundWeth(await helper.getAddress(), 20n * ONE);
        await helper.swapOnce(CFG_100, true, 20n * ONE); // a front-run sells ETH into the v4 pool
        const [skewed] = await helper.normalize(CFG_100);
        const before = await snapshot();

        const rc = await (await vh["ward(bytes32,address)"](id, PAYEE, { gasLimit: 3_000_000 })).wait();

        await expectCaptured(vh, rc, id, idAddr(V3_100), before);
        const [restored] = await helper.normalize(CFG_100);
        expect(restored).to.be.gt(skewed); // bought back up toward the v3 price
        await expectNothingKept(vh);
    });

    it("wards a dislocated v3 pool against a v4 pool, selling into it inside the PoolManager's lock", async function () {
        const { registry, vh, poker } = await networkHelpers.loadFixture(deployFixture);
        const id = await registerV4(registry, V4_500);
        await registry.setPools(WETH, USDG, [[id, 4, 500, 0], [idAddr(V3_500), 2, 500, 0]]);

        await fundWeth(await poker.getAddress(), 100n * ONE);
        await poker.poke(V3_500, true, 100n * ONE); // a front-run sells WETH into the v3 pool
        const before = await snapshot();

        const rc = await (await vh["ward(bytes32,address)"](idAddr(V3_500), PAYEE, { gasLimit: 3_000_000 })).wait();

        await expectCaptured(vh, rc, idAddr(V3_500), id, before);
        await expectNothingKept(vh);
    });

    // On Robinhood Chain there is no public mempool to back-run from: a ward runs inside the
    // swap's own transaction, from a router's step or a v4 hook, with the PoolManager's lock open.
    it("wards from inside a PoolManager lock someone else holds", async function () {
        const { registry, vh, helper, holder } = await networkHelpers.loadFixture(deployFixture);
        const id = await registerV4(registry, V4_100);
        await registry.setPools(WETH, USDG, [[idAddr(V3_100), 2, 100, 0], [id, 4, 100, 0]]);

        await fundWeth(await helper.getAddress(), 20n * ONE);
        await helper.swapOnce(CFG_100, true, 20n * ONE);
        const before = await snapshot();

        const rc = await (await holder.wardInV4Lock(await vh.getAddress(), id, PAYEE, CFG_100, true, 0n, { gasLimit: 3_000_000 })).wait();

        await expectCaptured(vh, rc, id, idAddr(V3_100), before);
        await expectNothingKept(vh);
    });

    it("captures the back-run of a swap made earlier in the same lock, each side settling its own", async function () {
        const { registry, vh, holder } = await networkHelpers.loadFixture(deployFixture);
        const id = await registerV4(registry, V4_100);
        await registry.setPools(WETH, USDG, [[idAddr(V3_100), 2, 100, 0], [id, 4, 100, 0]]);

        await fundWeth(await holder.getAddress(), 20n * ONE);
        const before = await snapshot();

        // the holder sells 20 ETH on the v4 pool, then wards it, all in one unlock
        const rc = await (await holder.wardInV4Lock(await vh.getAddress(), id, PAYEE, CFG_100, true, 20n * ONE, { gasLimit: 3_000_000 })).wait();

        await expectCaptured(vh, rc, id, idAddr(V3_100), before);
        const swapper = await holdings(await holder.getAddress());
        expect(swapper.usdg).to.be.gt(0n); // the swap's output is the holder's
        expect(swapper.weth).to.equal(0n); // and its input was paid
        await expectNothingKept(vh);
    });

    it("does nothing, and does not revert, when the pool is in line with its anchor", async function () {
        const { registry, vh } = await networkHelpers.loadFixture(deployFixture);
        const id = await registerV4(registry, V4_100);
        await registry.setPools(WETH, USDG, [[idAddr(V3_100), 2, 100, 0], [id, 4, 100, 0]]);

        await (await vh["ward(bytes32,address)"](id, PAYEE, { gasLimit: 3_000_000 })).wait();
        await expectNothingKept(vh);
    });
});
