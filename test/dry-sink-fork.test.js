import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// The anchor a ward sinks into, on a real Uniswap V4 PoolManager, its liquidity ending just past
// its price: the shape of the dust and one-sided anchors behind BNB Chain's TransferFailed()
// misses. The warded pool, a PancakeSwap V2 pair 4% above it, is driven down and its output sold
// into the anchor, which can take next to none of it.

const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF"; // Uniswap V4 PoolManager
const V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"; // PancakeSwap V2
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
// The suite's usual block. Its pools are new but for the PoolManager and the flipped Infinity pool,
// so any block serves: VH_FORK_BLOCK with BSC_ARCHIVE_URL forks a recent one through the archive
// tunnel, which serves the thousands of empty bitmap words a runaway sink swap reads far faster
// than the public archive does.
const BLOCK = Number(process.env.VH_FORK_BLOCK ?? 103808000);
const ONE = 10n ** 18n;
const Q96 = 1n << 96n;
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // PancakeSwap V2 USDT/WBNB
const NATIVE = "0x0000000000000000000000000000000000000000";
const INFI_NATIVE = [6, NATIVE, USDT, 67, 1, NATIVE, "0x0000000000000000000000000000000000000000000000000000000000010000"];

describeFork("VanHelsing against a V4 anchor whose liquidity ends past its price (fork)", function () {
    let conn, ethers;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
    });

    // Why a call reverted: a require's reason, or a custom error's selector.
    function reasonOf(e) {
        const data = e.data ?? e.info?.error?.data ?? "";
        if (typeof data === "string" && data.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
        return e.reason ?? (typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : e.shortMessage);
    }

    // The anchor: a V4 pool of `spacing` at `sqrtP`, its liquidity `liquidity` in [lower, upper].
    // The warded pool: a PancakeSwap V2 pair at a sqrt price of 1.02, or 1/1.02 `below`. `prefer`
    // ranks one of the two tokens as the bounty's (0 or 1), which makes the sink exact-out when it
    // is the token the drive outputs.
    async function setup({ spacing, sqrtP, lower, upper, prefer, liquidity = 10n ** 21n, below = false }) {
        const [signer] = await ethers.getSigners();
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
        const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
        const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
        const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
        const meta = [4, c0, c1, 500, spacing, NO_HOOKS, ZH];
        const key = [c0, c1, 500, spacing, NO_HOOKS];
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        await (await pm.initialize(key, sqrtP)).wait();
        const helper = await deploy(conn, "V4PoolHelper");
        await t0.mint(await helper.getAddress(), 1000n * ONE);
        await t1.mint(await helper.getAddress(), 1000n * ONE);
        await (await helper.addLiquidity(key, lower, upper, liquidity)).wait();
        const factory = new ethers.Contract(V2_FACTORY, ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"], signer);
        await (await factory.createPair(c0, c1)).wait();
        const pair = await factory.getPair(c0, c1);
        await t0.mint(pair, (100n * ONE * (below ? 102n : 100n)) / (below ? 100n : 102n));
        await t1.mint(pair, (100n * ONE * (below ? 100n : 102n)) / (below ? 102n : 100n));
        await (await new ethers.Contract(pair, ["function mint(address) returns (uint256)"], signer).mint(signer.address)).wait();
        const id = idV4(meta);
        await registry.setConfig(id, configV4(meta));
        await registry.setPools(c0, c1, [[id, 4, 500, 0], [idAddr(pair), 0, 25, 0]]);
        if (prefer !== undefined) await registry.setToken(prefer === 0 ? c0 : c1, 1, 0);
        return { vh, pair, tokens: [t0, t1] };
    }

    it("does not revert after its drive when the anchor runs dry", async function () {
        const { vh, pair, tokens } = await setup({ spacing: 10, sqrtP: Q96, lower: -600, upper: 20 });
        let reason = null, bounty = null;
        try {
            const rc = await (await vh.execute(idAddr(pair), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
            bounty = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty;
        } catch (e) {
            reason = reasonOf(e);
        }
        console.log(`      ${reason ?? `captured ${bounty}`}`);
        expect(reason).to.not.equal("0x90b8ec18"); // TransferFailed(): the anchor did not pay the drive
        if (reason !== null) expect(["NO_ARB", "BELOW_FLOOR"]).to.include(reason);
        for (const t of tokens) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // Spacing 1 and the price at the very top of its last tick: the dry walk still counts that tick
    // as liquid, so the anchor runs dry. Its swap must stop a gap past the warded pool's price
    // before the drive, not walk every empty word of its bitmap to the end of the price range.
    // Exact-in (no preference) and exact-out (the bounty in the token the drive outputs, token1).
    it("a sink that runs dry stops a gap past the driver's price", async function () {
        const top = 79232123823359799118286999567n; // getSqrtPriceAtTick(1) - 1: tick 0, at its very top
        for (const prefer of [undefined, 1]) {
            const { vh, pair, tokens } = await setup({ spacing: 1, sqrtP: top, lower: -600, upper: 1, prefer });
            const rc = await (await vh["ward(bytes32,address)"](idAddr(pair), BENEFICIARY, { gasLimit: 30_000_000 })).wait();
            const captured = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
            console.log(`      ${prefer === undefined ? "exact-in" : "exact-out"}: ${rc.gasUsed} gas, ${captured ? `captured ${captured.args.bounty}` : "nothing captured"}`);
            expect(rc.gasUsed).to.be.lt(600_000n);
            for (const t of tokens) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
        }
    });

    // A V4 anchor 100x shallower than the pair, its liquidity ending at the edge of the tick its
    // price sits in, wherever in that tick, the pair above it or below, the bounty in either token:
    // the pools round what they are owed up and what they pay down, and the ward still never takes
    // more than the anchor holds.
    it("an anchor priced anywhere inside its last tick is never overdrawn", async function () {
        const sqrtAt = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
        const outcomes = [];
        for (const below of [false, true])
            for (const prefer of [undefined, below ? 0 : 1])
                for (const at of [5, 50, 95]) {
                    const [lower, upper, tick] = below ? [-100, 600, -at] : [-600, 100, at];
                    const { vh, pair, tokens } = await setup({ spacing: 100, sqrtP: sqrtAt(tick + 0.37), lower, upper, prefer, liquidity: 10n ** 18n, below });
                    let reason = null;
                    try {
                        await (await vh.execute(idAddr(pair), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
                    } catch (e) {
                        reason = reasonOf(e);
                    }
                    outcomes.push(`${below ? "below" : "above"} ${prefer === undefined ? "in" : "out"} ${at}%: ${reason ?? "captured"}`);
                    expect(reason, outcomes.at(-1)).to.not.be.oneOf(["0x90b8ec18", "SINK_SHORT"]);
                    for (const t of tokens) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
                }
        console.log(`      ${outcomes.join(", ")}`);
    });

    // A warded V4 pool deep right at its price and thin beyond (a narrow position on a wide one), 4%
    // above a V4 anchor whose liquidity ends 10 ticks past its price. The restore stops where the
    // anchor runs dry, a way the warded pool covers within its narrow position: counted at the mean
    // its walk reads over the whole way to the anchor, 37 times shallower, the drive puts out more
    // than the anchor can take. Both payouts.
    it("a driver deep at its price is counted at that depth where its sink runs dry", async function () {
        const [signer] = await ethers.getSigners();
        const sqrtAt = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        for (const prefer of [undefined, 1]) {
            const registry = await deploy(conn, "PoolRegistryHarness");
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
            const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
            const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
            const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
            const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
            const helper = await deploy(conn, "V4PoolHelper");
            await t0.mint(await helper.getAddress(), 1000n * ONE);
            await t1.mint(await helper.getAddress(), 1000n * ONE);
            const anchor = [4, c0, c1, 500, 10, NO_HOOKS, ZH], warded = [4, c0, c1, 3000, 10, NO_HOOKS, ZH];
            await (await pm.initialize([c0, c1, 500, 10, NO_HOOKS], Q96)).wait();
            await (await helper.addLiquidity([c0, c1, 500, 10, NO_HOOKS], -600, 10, 10n ** 21n)).wait();
            await (await pm.initialize([c0, c1, 3000, 10, NO_HOOKS], sqrtAt(392))).wait();
            await (await helper.addLiquidity([c0, c1, 3000, 10, NO_HOOKS], 380, 400, 10n ** 21n)).wait();
            await (await helper.addLiquidity([c0, c1, 3000, 10, NO_HOOKS], -1000, 1000, 10n ** 18n)).wait();
            for (const m of [anchor, warded]) await registry.setConfig(idV4(m), configV4(m));
            await registry.setPools(c0, c1, [[idV4(anchor), 4, 500, 0], [idV4(warded), 4, 3000, 0]]);
            if (prefer !== undefined) await registry.setToken(c1, 1, 0);
            let reason = null, bounty = null;
            try {
                const rc = await (await vh.execute(idV4(warded), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
                bounty = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty;
            } catch (e) {
                reason = reasonOf(e);
            }
            console.log(`      ${prefer === undefined ? "exact in" : "exact out"}: ${reason ?? `captured ${bounty}`}`);
            expect(reason).to.equal(null);
            expect(bounty).to.be.gt(0n);
            for (const t of [t0, t1]) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
        }
    });

    // A warded V4 pool deep only in a narrow position right at its price (1e23 in [390, 400], its
    // price at tick 392) over a wide thin one (1e21 in [-1000, 1000]), 4% above a V4 anchor holding
    // 1e22 from -600. The restore takes the anchor to about tick 36, so an anchor whose liquidity ends
    // at tick 200 captures exactly what one whose liquidity reaches tick 2000 does: counted at its
    // depth at its price over the whole way, the warded pool would be capped a few ticks from its
    // price. Both payouts.
    it("a driver deep in a sliver at its price is capped only where its drive meets the cliff", async function () {
        const [signer] = await ethers.getSigners();
        const sqrtAt = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        const bounty = async (anchorUpper, prefer) => {
            const registry = await deploy(conn, "PoolRegistryHarness");
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
            const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
            const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
            const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
            const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
            const helper = await deploy(conn, "V4PoolHelper");
            await t0.mint(await helper.getAddress(), 10n ** 24n);
            await t1.mint(await helper.getAddress(), 10n ** 24n);
            const anchor = [4, c0, c1, 500, 10, NO_HOOKS, ZH], warded = [4, c0, c1, 3000, 10, NO_HOOKS, ZH];
            await (await pm.initialize([c0, c1, 500, 10, NO_HOOKS], Q96)).wait();
            await (await helper.addLiquidity([c0, c1, 500, 10, NO_HOOKS], -600, anchorUpper, 10n ** 22n)).wait();
            await (await pm.initialize([c0, c1, 3000, 10, NO_HOOKS], sqrtAt(392))).wait();
            await (await helper.addLiquidity([c0, c1, 3000, 10, NO_HOOKS], 390, 400, 10n ** 23n)).wait();
            await (await helper.addLiquidity([c0, c1, 3000, 10, NO_HOOKS], -1000, 1000, 10n ** 21n)).wait();
            for (const m of [anchor, warded]) await registry.setConfig(idV4(m), configV4(m));
            await registry.setPools(c0, c1, [[idV4(anchor), 4, 500, 0], [idV4(warded), 4, 3000, 0]]);
            if (prefer !== undefined) await registry.setToken(c1, 1, 0);
            const rc = await (await vh.execute(idV4(warded), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
            for (const t of [t0, t1]) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
            return rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty;
        };
        for (const prefer of [undefined, 1]) {
            const [cliff, open] = [await bounty(200, prefer), await bounty(2000, prefer)];
            console.log(`      ${prefer === undefined ? "exact in" : "exact out"}: liquidity to tick 200 ${cliff}; to tick 2000 ${open}`);
            expect(open).to.be.gt(0n);
            expect(cliff).to.equal(open);
        }
    });

    // An anchor holding seven positions of 1e21, from ticks -10, -20 ... -70 up to 2000, at tick 0,
    // the warded V4 pool at tick -400. Walking down, the anchor's first step is its word's end, so it
    // runs dry on its eighth and last step. With a deep second island (1e22 from 10 ticks past the
    // stairs), the pool is two islands: the ward captures what the deployed contract does, to the
    // wei, both payouts. Without one, the stairs thin toward the cliff, and an exact-in sink capped
    // at it is sized from what its spans hold: it captures, and nothing stays in VanHelsing.
    it("an anchor that runs dry on its walk's last step is capped by what its spans hold", async function () {
        const [signer] = await ethers.getSigners();
        const sqrtAt = (tick) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        const ward = async (second, prefer) => {
            const registry = await deploy(conn, "PoolRegistryHarness");
            const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
            const x = await deploy(conn, "MockERC20", null, ["X", "X"]);
            const y = await deploy(conn, "MockERC20", null, ["Y", "Y"]);
            const [t0, t1] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x, y] : [y, x];
            const [c0, c1] = [await t0.getAddress(), await t1.getAddress()];
            const helper = await deploy(conn, "V4PoolHelper");
            await t0.mint(await helper.getAddress(), 10n ** 27n);
            await t1.mint(await helper.getAddress(), 10n ** 27n);
            const anchor = [4, c0, c1, 500, 10, NO_HOOKS, ZH], warded = [4, c0, c1, 3000, 10, NO_HOOKS, ZH];
            await (await pm.initialize([c0, c1, 500, 10, NO_HOOKS], Q96)).wait();
            for (let k = 1; k <= 7; k++) await (await helper.addLiquidity([c0, c1, 500, 10, NO_HOOKS], -10 * k, 2000, 10n ** 21n)).wait();
            if (second) await (await helper.addLiquidity([c0, c1, 500, 10, NO_HOOKS], -2000, -80, 10n ** 22n)).wait();
            await (await pm.initialize([c0, c1, 3000, 10, NO_HOOKS], sqrtAt(-400))).wait();
            await (await helper.addLiquidity([c0, c1, 3000, 10, NO_HOOKS], -2000, 2000, 10n ** 22n)).wait();
            for (const m of [anchor, warded]) await registry.setConfig(idV4(m), configV4(m));
            await registry.setPools(c0, c1, [[idV4(anchor), 4, 500, 0], [idV4(warded), 4, 3000, 0]]);
            if (prefer !== undefined) await registry.setToken(c0, 1, 0);
            let out;
            try {
                const rc = await (await vh.execute(idV4(warded), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
                out = { bounty: rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty };
            } catch (e) {
                out = { reason: reasonOf(e) };
            }
            for (const t of [t0, t1]) expect(await t.balanceOf(await vh.getAddress())).to.equal(0n);
            return out;
        };
        // What the deployed contract captures with the second island (main at 0fbcd7b, on this fork).
        const deployed = { in: 1133353720750230862n, out: 1151705443809395397n };
        for (const prefer of [undefined, 0]) {
            const pay = prefer === undefined ? "in" : "out";
            const [islands, stairs] = [await ward(true, prefer), await ward(false, prefer)];
            console.log(`      exact ${pay}: with the second island ${islands.bounty ?? islands.reason}; stairs alone ${stairs.bounty ?? stairs.reason}`);
            expect(islands.bounty, `exact ${pay}, two islands: ${islands.reason}`).to.equal(deployed[pay]);
            expect(stairs.bounty ?? 0n, `exact ${pay}, stairs alone: ${stairs.reason}`).to.be.gt(0n);
        }
    });

    // A flipped sink whose liquidity ends past its price: a Uniswap V4 pool of native BNB and a token
    // X on the X/WBNB pair, so its prices are the inverse of the pair's. In its own currency space
    // its price is 1 and its liquidity runs from tick -20 up; the ward pushes it down there (up on
    // the pair), so it runs dry at -20, which its walk keeps in token space, inverted. The warded
    // pool, a PancakeSwap V2 X/WBNB pair 4% above on the pair, must not overdraw it.
    it("a flipped sink's cliff is kept in token space and caps the restore", async function () {
        const [signer] = await ethers.getSigners();
        const { networkHelpers } = conn;
        let x;
        do x = await deploy(conn, "MockERC20", null, ["X", "X"]); while (BigInt(await x.getAddress()) >= BigInt(WBNB));
        const xa = await x.getAddress();
        const key = [NATIVE, xa, 500, 10, NO_HOOKS];
        const meta = [4, NATIVE, xa, 500, 10, NO_HOOKS, ZH];
        const pm = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)"], signer);
        await (await pm.initialize(key, Q96)).wait();
        const helper = await deploy(conn, "V4PoolHelper");
        await networkHelpers.setBalance(await helper.getAddress(), 1000n * ONE);
        await x.mint(await helper.getAddress(), 1000n * ONE);
        await (await helper.addLiquidity(key, -20, 600, 10n ** 21n)).wait();
        const wbnb = new ethers.Contract(WBNB, ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], signer);
        await networkHelpers.setBalance(signer.address, 1000n * ONE);
        await (await wbnb.deposit({ value: 200n * ONE })).wait();
        const factory = new ethers.Contract(V2_FACTORY, ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"], signer);
        await (await factory.createPair(xa, WBNB)).wait();
        const pair = await factory.getPair(xa, WBNB);
        await x.mint(pair, (100n * ONE * 100n) / 102n);
        await (await wbnb.transfer(pair, (100n * ONE * 102n) / 100n)).wait();
        await (await new ethers.Contract(pair, ["function mint(address) returns (uint256)"], signer).mint(signer.address)).wait();
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const id = idV4(meta);
        await registry.setConfig(id, configV4(meta));
        await registry.setPools(xa, WBNB, [[id, 4, 500, 0], [idAddr(pair), 0, 25, 0]]);
        // its walk toward the pair's price keeps the cliff at tick -20 inverted: 2^192 / TickMath(-20)
        const depth = await deploy(conn, "V4DepthHarness", null, [], { libraries: { V4Depth: null } });
        const cliff = await depth.cliffOf(configV4(meta), (Q96 * 102n) / 100n, 8);
        expect(cliff).to.equal((1n << 192n) / 79148977909814923576066331265n);
        let reason = null, bounty = null;
        try {
            const rc = await (await vh.execute(idAddr(pair), BENEFICIARY, { gasLimit: 15_000_000 })).wait();
            bounty = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured")?.args.bounty;
        } catch (e) {
            reason = reasonOf(e);
        }
        console.log(`      ${reason ?? `captured ${bounty}`}`);
        expect(reason).to.not.be.oneOf(["0x90b8ec18", "SINK_SHORT"]);
        expect(await x.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
    });

    // A flipped sink: PancakeSwap Infinity's native BNB/USDT pool, whose currency0 is native on the
    // USDT/WBNB pair, so its price and the limit invert between the pool and the pair. The warded
    // PancakeSwap V2 pair takes 300 WBNB first, as scripts/gas-bench.mjs does.
    it("the limit works on a flipped sink", async function () {
        const { networkHelpers } = conn;
        const snap = await networkHelpers.takeSnapshot();
        const [whale] = await ethers.getSigners();
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        await registry.setConfig(idV4(INFI_NATIVE), configV4(INFI_NATIVE));
        await registry.setPools(USDT, WBNB, [[idV4(INFI_NATIVE), 6, 67, 0], [idAddr(V2_PANCAKE), 0, 25, 0]]);
        await registry.setToken(WBNB, 8, 0);
        await registry.setToken(USDT, 7, 0);
        const wbnb = new ethers.Contract(WBNB, ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], whale);
        await networkHelpers.setBalance(whale.address, 301n * ONE);
        await (await wbnb.deposit({ value: 300n * ONE })).wait();
        await (await wbnb.transfer(V2_PANCAKE, 300n * ONE)).wait();
        await (await new ethers.Contract(V2_PANCAKE, ["function sync() external"], whale).sync()).wait();
        const rc = await (await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 5_000_000 })).wait();
        const captured = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
        console.log(`      ${rc.gasUsed} gas, ${captured ? `captured ${captured.args.bounty}` : "nothing captured"}`);
        expect(captured, "the ward captures").to.not.equal(undefined);
        expect(captured.args.bounty).to.be.gt(0n);
        const usdt = new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], whale);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        await snap.restore();
    });
});
