import { network } from "hardhat";
import { expect } from "chai";
import { toBeHex, zeroPadValue } from "ethers";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// A ward inside a lock someone else holds settles into that lock's singleton, and the manager
// checks the books only when the holder's unlock ends. A token that loses part of every
// transfer into the manager, on a pool the registry states untaxed (a stale probe, or a tax
// switched on since), would leave VanHelsing owing there and revert the holder's whole
// transaction. VanHelsing must fail its own attempt instead, which ward() swallows, and leave
// the lock as it found it.

const PM = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF"; // Uniswap V4 PoolManager
const VAULT = "0x238a358808379702088667322f80aC48bAd5e6c4"; // Pancake Infinity Vault
const CL = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b"; // Pancake Infinity CL pool manager
const V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"; // PancakeSwap V2
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDT_HOLDER = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const BLOCK = 103808000;
const ONE = 10n ** 18n;
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };
const FEE = 3000;
const SPACING = 60;
const L = 5n * 10n ** 22n;
const SQRT_ONE = 1n << 96n; // both tokens have 18 decimals: a price of 1
const TAX_BPS = 300;

describeFork("VanHelsing inside a lock someone else holds, settling a token taxed into the manager", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    async function usdtTo(to, amount) {
        await networkHelpers.impersonateAccount(USDT_HOLDER);
        await networkHelpers.setBalance(USDT_HOLDER, ONE);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        await usdt.connect(await ethers.getSigner(USDT_HOLDER)).transfer(to, amount);
        await networkHelpers.stopImpersonatingAccount(USDT_HOLDER);
    }

    // A TAX/USDT singleton of `kind` and a Pancake V2 TAX/USDT pair, both at a price of 1, listed
    // with no tax. TAX is still untaxed here; each test switches its tax on.
    async function setup(kind) {
        const [signer] = await ethers.getSigners();
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: LIBS });
        const holder = await deploy(conn, "LockHolder", null, [], { libraries: { UniV4Lib: null, InfinityLib: null } });
        const tax = await deploy(conn, "MockTaxToken", null, ["Taxed", "TAX"]);
        const taxAddr = await tax.getAddress();
        const [c0, c1] = BigInt(taxAddr) < BigInt(USDT) ? [taxAddr, USDT] : [USDT, taxAddr];

        const uni = kind === 4;
        const params = zeroPadValue(toBeHex(SPACING << 16), 32);
        const meta = uni ? [4, c0, c1, FEE, SPACING, NO_HOOKS, ZH] : [6, c0, c1, FEE, SPACING, NO_HOOKS, params];
        const key = uni ? [c0, c1, FEE, SPACING, NO_HOOKS] : [c0, c1, NO_HOOKS, CL, FEE, params];
        const initAbi = uni
            ? "function initialize((address,address,uint24,int24,address),uint160) returns (int24)"
            : "function initialize((address,address,address,address,uint24,bytes32),uint160) returns (int24)";
        await new ethers.Contract(uni ? PM : CL, [initAbi], signer).initialize(key, SQRT_ONE);
        const helper = await deploy(conn, uni ? "V4PoolHelper" : "InfinityPoolHelper");
        await tax.mint(await helper.getAddress(), 20_000n * ONE);
        await usdtTo(await helper.getAddress(), 20_000n * ONE);
        await helper.addLiquidity(key, -6000, 6000, L);

        const factory = new ethers.Contract(V2_FACTORY, ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"], signer);
        await (await factory.createPair(taxAddr, USDT)).wait();
        const pair = await factory.getPair(taxAddr, USDT);
        await tax.mint(pair, 10_000n * ONE);
        await usdtTo(pair, 10_000n * ONE);
        await (await new ethers.Contract(pair, ["function mint(address) returns (uint256)"], signer).mint(signer.address)).wait();

        const id = idV4(meta);
        await registry.setConfig(id, configV4(meta));
        await registry.setPools(taxAddr, USDT, [[idAddr(pair), 0, 25, 0], [id, kind, FEE, 0]]);
        await usdtTo(await holder.getAddress(), 2_000n * ONE);
        return { registry, vh, holder, tax, meta, id, pair, custody: uni ? PM : VAULT, usdtIs0: c0 === USDT };
    }

    // The bounty a call paid, read off its Captured event (zero without one).
    async function bounty(vh, tx) {
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
        return ev ? ev.args.bounty : 0n;
    }

    // The holder buys TAX with USDT on the singleton inside its lock, then wards that singleton
    // in the same lock: VanHelsing drives it, selling TAX back, and settles the TAX it owes there.
    async function driveInHeldLock(kind) {
        const s = await setup(kind);
        const cfg = configV4(s.meta);
        const call = () => kind === 4
            ? s.holder.wardInV4Lock(s.vh.getAddress(), s.id, BENEFICIARY, cfg, s.usdtIs0, 1_500n * ONE, { gasLimit: 6_000_000 })
            : s.holder.wardInInfinityLock(s.vh.getAddress(), s.id, BENEFICIARY, cfg, s.usdtIs0, 1_500n * ONE, { gasLimit: 6_000_000 });
        const untaxed = await networkHelpers.takeSnapshot();
        expect(await bounty(s.vh, await call())).to.be.gt(0n); // the control: the drive is real and captures
        await untaxed.restore();
        await s.tax.setTax(s.custody, 0, TAX_BPS);
        expect(await bounty(s.vh, await call())).to.equal(0n);
    }

    it("a Uniswap V4 drive: the holder's transaction goes through and the ward captures nothing", async function () {
        await driveInHeldLock(4);
    });

    it("a Pancake Infinity drive: the holder's transaction goes through and the ward captures nothing", async function () {
        await driveInHeldLock(6);
    });

    // TAX dumped into the pair: VanHelsing drives the pair, buying TAX, and sinks it into the
    // Uniswap V4 pool exact-out (TAX is the payout token), settling the TAX the sink costs.
    it("a sink into Uniswap V4: the holder's transaction goes through and the ward captures nothing", async function () {
        const s = await setup(4);
        await s.registry.setToken(await s.tax.getAddress(), 9, 0);
        await s.registry.setToken(USDT, 7, 0);
        await s.tax.mint(s.pair, 300n * ONE);
        await new ethers.Contract(s.pair, ["function sync() external"], (await ethers.getSigners())[0]).sync();
        const cfg = configV4(s.meta);
        const call = () => s.holder.wardInV4Lock(s.vh.getAddress(), idAddr(s.pair), BENEFICIARY, cfg, false, 0n, { gasLimit: 6_000_000 });
        const untaxed = await networkHelpers.takeSnapshot();
        expect(await bounty(s.vh, await call())).to.be.gt(0n);
        await untaxed.restore();
        await s.tax.setTax(PM, 0, TAX_BPS);
        expect(await bounty(s.vh, await call())).to.equal(0n);
    });
});
