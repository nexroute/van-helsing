import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, registerV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

// Real taxed tokens on a BSC fork. Each case is a token that takes a fee on transfer,
// traded in a V2 pair and in a V3 or Infinity pool. The taxes each pool actually takes
// are measured on the fork with VanHelsing's own address as the counterparty, the way
// the Van Helsing node measures them; then a front-run is simulated on the V2 pair in
// both directions (one side of the pair pulled out, then sync). With the taxes
// VanHelsing restores the pair and is paid in the untaxed token; registered as untaxed,
// the same ward pays the pair short and dies, or captures less.
// The block is recent: run it with BSC_ARCHIVE_URL pointing at an archive node.

const BLOCK = 128221000;
const ONE = 10n ** 18n;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const VAULT = "0x238a358808379702088667322f80aC48bAd5e6c4"; // Pancake Infinity Vault
const POOL_MANAGER = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF"; // Uniswap V4
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const PARAMS_TS1 = "0x0000000000000000000000000000000000000000000000000000000000010000"; // tick spacing 1
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const PAIR_ABI = ["function sync() external"];
const LIBS = {
    libraries: {
        CurveLib: null, UniV4Lib: null, InfinityLib: null,
        V3Depth: null, V4Depth: null, RouteLib: null,
    },
};

const CASES = [
    {
        name: "Jager/WBNB, V2 pair against a 0.05% V3 pool",
        taxed: "0x74836cC0E821A6bE18e407E6388E430B689C66e9", // Jager, token0
        base: WBNB,
        v2: "0x589e1c953bcb822a2094fd8c7cbbd84a7762fb04",
        v2Fee: 25,
        alt: { kind: 2, pool: "0xaa8fadca5d1f36e24c919168d0d4c7b12fec8d32", fee: 500 },
    },
    {
        name: "OK/USDT, V2 pair against a 0.01% Uniswap V4 pool",
        taxed: "0x3c54bE79B841fB5E886940D7a861AC11ff389C3e", // OK, token0
        base: USDT,
        v2: "0xde49e70be18722968dff0d1256588ad85e7d5526",
        v2Fee: 25,
        alt: { kind: 4, fee: 100, custody: POOL_MANAGER, meta: [4, "0x3c54bE79B841fB5E886940D7a861AC11ff389C3e", USDT, 100, 1, NO_HOOKS, ZH] },
    },
    {
        // Controls: no tax, the deep USDT/WBNB pools. The Infinity pool is native/USDT, so
        // exact-in sinks into it pay first in both currencies (USDT, and native BNB
        // unwrapped from WBNB); without a payout preference every sink is exact-in.
        name: "control, USDT/WBNB V2 pair against the native Infinity pool, paid in WBNB",
        taxed: USDT,
        base: WBNB,
        v2: "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
        v2Fee: 25,
        control: true,
        alt: { kind: 6, fee: 67, custody: VAULT, meta: [6, NO_HOOKS, USDT, 67, 1, NO_HOOKS, PARAMS_TS1] },
    },
    {
        name: "control, USDT/WBNB V2 pair against the native Infinity pool, no payout preference",
        taxed: USDT,
        base: WBNB,
        v2: "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
        v2Fee: 25,
        control: true,
        noPreference: true,
        alt: { kind: 6, fee: 67, custody: VAULT, meta: [6, NO_HOOKS, USDT, 67, 1, NO_HOOKS, PARAMS_TS1] },
    },
    {
        // Chaos refuses transfers a contract makes (they revert TransferFailed), so no
        // one can arb it from a contract: the ward has to no-op cleanly.
        name: "Chaos/USDT, V2 pair against a 1% Infinity pool",
        taxed: "0x19F46FDDbaC1ab00D203Cc80515a44E320260419", // Chaos, token0
        base: USDT,
        v2: "0x16f06339447daa1b742934e7f44c2cc018f07513",
        v2Fee: 25,
        refuses: true,
        // PoolKey fee 10000, tick spacing 200 (parameters 0xc80000), no hook.
        alt: {
            kind: 6, fee: 10000, custody: VAULT,
            meta: [6, "0x19F46FDDbaC1ab00D203Cc80515a44E320260419", USDT, 10000, 200, NO_HOOKS,
                "0x0000000000000000000000000000000000000000000000000000000000c80000"],
        },
    },
    {
        name: "USDT/MarsCoin, V2 pair against a 0.25% V3 pool",
        taxed: "0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777", // MarsCoin, token1
        base: USDT,
        v2: "0x4ba740c0cccadaaec82f42ac6c9294106ff2713f",
        v2Fee: 30,
        alt: { kind: 2, pool: "0x14ca9d552ed2cf0d5dfd1f89bc6793a464e2ed16", fee: 2500 },
    },
];

describeFork("VanHelsing on real taxed tokens (fork)", function () {
    let conn, ethers, helpers;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        helpers = conn.networkHelpers;
    });

    async function as(addr, fn) {
        await helpers.impersonateAccount(addr);
        await helpers.setBalance(addr, 10n * ONE);
        try { return await fn(await ethers.getSigner(addr)); } finally { await helpers.stopImpersonatingAccount(addr); }
    }

    const erc20 = (a) => ethers.getContractAt("IERC20", a);

    // Basis points a transfer of `amt` from `from` to `to` loses, rounded up as the
    // node rounds. State changes are rolled back.
    async function lost(token, from, to, amt) {
        const snap = await helpers.takeSnapshot();
        try {
            const t = await erc20(token);
            const before = await t.balanceOf(to);
            await as(from, (s) => t.connect(s).transfer(to, amt));
            const got = (await t.balanceOf(to)) - before;
            return Number(((amt - got) * 10000n + amt - 1n) / amt);
        } finally {
            await snap.restore();
        }
    }

    // The taxed token's (taxIn, taxOut) at a pool whose tokens sit in `custody`, `pair`
    // when that is a V2 pair. VanHelsing is funded from the custody (and a pair synced,
    // so its reserves match its balance again), and the sale back is made twice: many
    // such tokens sell the tax they collected into their pair on the first sale they
    // see, which would show up as the pair receiving more than it was sent.
    async function measure(token, custody, vh, pair) {
        const t = await erc20(token);
        const probe = (await t.balanceOf(custody)) / 1000n;
        const out = await lost(token, custody, vh, probe);
        const snap = await helpers.takeSnapshot();
        try {
            await as(custody, (s) => t.connect(s).transfer(vh, probe));
            if (pair) await new ethers.Contract(custody, PAIR_ABI, (await ethers.getSigners())[0]).sync();
            const held = await t.balanceOf(vh);
            await as(vh, (s) => t.connect(s).transfer(custody, held / 2n));
            return { inn: Math.max(0, await lost(token, vh, custody, await t.balanceOf(vh))), out };
        } finally {
            await snap.restore();
        }
    }

    function word(c, tax) {
        const tIs0 = c.taxed.toLowerCase() < c.base.toLowerCase();
        return tIs0 ? (BigInt(tax.inn) << 48n) | (BigInt(tax.out) << 32n) : (BigInt(tax.inn) << 16n) | BigInt(tax.out);
    }

    async function setup(c, withTaxes) {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], LIBS);
        const vhAddr = await vh.getAddress();
        const altId = c.alt.meta ? await registerV4(registry, c.alt.meta) : idAddr(c.alt.pool);
        const taxes = withTaxes
            ? { v2: await measure(c.taxed, c.v2, vhAddr, true), alt: await measure(c.taxed, c.alt.custody ?? c.alt.pool, vhAddr, false) }
            : { v2: { inn: 0, out: 0 }, alt: { inn: 0, out: 0 } };
        // The node's hub preference: paid in WBNB or USDT.
        if (!c.noPreference) await registry.setToken(c.base, c.base === WBNB ? 5 : 4, 0);
        await registry.setPools(c.taxed, c.base, [
            [idAddr(c.v2), 0, c.v2Fee, word(c, taxes.v2)],
            [altId, c.alt.kind, c.alt.fee, word(c, taxes.alt)],
        ]);
        return { vh, taxes };
    }

    // Pull `perMille` of one side out of the pair and sync, as a front-run moves it.
    async function skew(c, token, perMille) {
        const t = await erc20(token);
        const amt = ((await t.balanceOf(c.v2)) * BigInt(perMille)) / 1000n;
        await as(c.v2, (s) => t.connect(s).transfer(DEAD, amt));
        await new ethers.Contract(c.v2, PAIR_ABI, (await ethers.getSigners())[0]).sync();
    }

    async function wardOnce(c, vh) {
        const base = await erc20(c.base), taxed = await erc20(c.taxed);
        const pre = await base.balanceOf(BENEFICIARY);
        const preT = await taxed.balanceOf(BENEFICIARY);
        const rc = await (await vh["ward(bytes32,address)"](idAddr(c.v2), BENEFICIARY, { gasLimit: 3_000_000 })).wait();
        const vhAddr = await vh.getAddress();
        expect(await base.balanceOf(vhAddr), "base left in VanHelsing").to.equal(0n);
        expect(await taxed.balanceOf(vhAddr), "taxed token left in VanHelsing").to.equal(0n);
        const gotT = (await taxed.balanceOf(BENEFICIARY)) - preT;
        if (!c.control) expect(gotT, "paid in the taxed token").to.equal(0n);
        return { got: (await base.balanceOf(BENEFICIARY)) - pre, gotT, gas: rc.gasUsed };
    }

    for (const c of CASES) {
        for (const dir of ["cheap", "dear"]) {
            it(`${c.name}: taxed token ${dir} at the pair, ${c.refuses ? "no-ops" : "captures with the taxes"}`, async function () {
                const snap = await helpers.takeSnapshot();
                try {
                    // cheap: base pulled out of the pair, so the pair sells the taxed
                    // token cheap and drives. dear: the taxed token pulled out, so the
                    // alt sells it cheaper, drives, and the pair is the sink.
                    await skew(c, dir === "cheap" ? c.base : c.taxed, 100);
                    const s = await helpers.takeSnapshot();
                    const untaxed = await wardOnce(c, (await setup(c, false)).vh);
                    await s.restore();
                    const { vh, taxes } = await setup(c, true);
                    const r = await wardOnce(c, vh);
                    console.log(`      taxes pair in/out ${taxes.v2.inn}/${taxes.v2.out} bps, alt ${taxes.alt.inn}/${taxes.alt.out}; captured ${ethers.formatUnits(r.got, 18)} (gas ${r.gas}), registered untaxed ${ethers.formatUnits(untaxed.got, 18)}`);
                    if (c.control) {
                        console.log(`      control also paid ${ethers.formatUnits(r.gotT, 18)} of the other token`);
                        expect(r.got + r.gotT > 0n, "captured nothing").to.equal(true);
                        return;
                    }
                    if (c.refuses) {
                        expect(r.got).to.equal(0n);
                        return;
                    }
                    expect(r.got > 0n, "captured nothing").to.equal(true);
                    expect(r.got >= untaxed.got).to.equal(true);
                } finally {
                    await snap.restore();
                }
            });
        }
    }
});
