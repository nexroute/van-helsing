import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPublicClient, encodeFunctionData, http, pad, parseAbi, parseEther } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { planWards } from "../src/plan.js";

// planWards end to end on BNB Chain's latest block, against the real contract's code: its bundle
// (the bytecode the in-node engine runs) is injected into the simulation with a registry of its
// own, seeded with PancakeSwap's USDT/WBNB pools, so the test does not depend on what the
// deployed registry lists. Then 300 BNB swaps through PancakeSwap's V2 router are planned: one
// that sends BNB, one that pays WBNB it must wrap and approve first, one due within seconds.
// Opt in with an RPC that serves eth_simulateV1 with state overrides:
//
//   VH_LIVE_RPC=http://127.0.0.1:8545 node --test test/live.test.js

const RPC = process.env.VH_LIVE_RPC;
// The bundle sits beside the SDK in the development repository, and is read only when the test
// runs: CI tests the SDK on its own, without the repository around it.
const BUNDLE = new URL("../../measurement/framework/fixtures/inject-bundle.json", import.meta.url);
const skip = !RPC ? "set VH_LIVE_RPC" : !fs.existsSync(BUNDLE) && "needs Van Helsing's bundle, measurement/framework/fixtures/inject-bundle.json";
const bundle = skip ? null : JSON.parse(fs.readFileSync(BUNDLE, "utf8"));

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V2_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // PancakeSwap V2 USDT/WBNB
const V3_500 = "0x36696169C63e42cd08ce11f5deeBbCeBae652050"; // PancakeSwap V3 USDT/WBNB 0.05%
const V3_100 = "0x172fcD41E0913e95784454622d1c3724f546f849"; // PancakeSwap V3 USDT/WBNB 0.01%
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap V2 router
const OWNER = "0x00000000000000000000000000000000000004e1";
const SWAPPER = "0x00000000000000000000000000000000000A11cE";

const REGISTRY_ABI = parseAbi([
    "function setPools(address a, address b, (bytes32 id, uint8 kind, uint32 fee, uint64 tax)[] pools)",
    "function setToken(address token, uint128 priority, uint128 minProfit)",
]);
const ROUTER_ABI = parseAbi([
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);
const WBNB_ABI = parseAbi(["function deposit() payable", "function approve(address spender, uint256 amount) returns (bool)"]);
const id = (a) => pad(a.toLowerCase(), { size: 32 });

// What every simulation starts with: VanHelsing as the chain runs it (its proxy's code at
// VH_ADDR, the ERC-1967 slot naming IMPL_ADDR, the contract's code there, where its attempts
// delegatecall), its registry and its libraries injected, the registry owned by OWNER, also its
// operator (slot 1), who writes it, and seeded as the in-node engine seeds it.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const injected = bundle && {
    [bundle.VH_ADDR]: { code: bundle.proxyCode, stateDiff: { [IMPL_SLOT]: pad(bundle.IMPL_ADDR.toLowerCase(), { size: 32 }) } },
    [bundle.IMPL_ADDR]: { code: bundle.vhCode },
    [bundle.REGISTRY_ADDR]: {
        code: bundle.regCode,
        stateDiff: {
            [`0x${"0".repeat(64)}`]: pad(OWNER.toLowerCase(), { size: 32 }),
            [`0x${"0".repeat(63)}1`]: pad(OWNER.toLowerCase(), { size: 32 }),
        },
    },
    ...Object.fromEntries(Object.entries(bundle.libs).map(([addr, code]) => [addr, { code }])),
};
const seeding = bundle && {
    calls: [
        { from: OWNER, to: bundle.REGISTRY_ADDR, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "setPools", args: [USDT, WBNB, [
            { id: id(V2_PAIR), kind: 0, fee: 25, tax: 0n },
            { id: id(V3_500), kind: 2, fee: 500, tax: 0n },
            { id: id(V3_100), kind: 2, fee: 100, tax: 0n },
        ]] }) },
        { from: OWNER, to: bundle.REGISTRY_ADDR, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "setToken", args: [WBNB, 5n, 0n] }) },
        { from: OWNER, to: bundle.REGISTRY_ADDR, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "setToken", args: [USDT, 4n, 0n] }) },
    ],
};

// A client whose eth_simulateV1 runs the seeding calls first, in the caller's own block, which
// the SDK stamps a second after its parent: a block of their own would have to fit in between.
// It answers with the caller's calls only.
function seededClient() {
    const client = createPublicClient({ chain: bsc, transport: http(RPC, { timeout: 60_000 }) });
    return {
        ...client,
        chain: bsc,
        async request(args) {
            if (args.method !== "eth_simulateV1") return client.request(args);
            const [opts, block] = args.params;
            const [first, ...rest] = opts.blockStateCalls;
            const seeded = { ...first, stateOverrides: { ...injected, ...first.stateOverrides }, calls: [...seeding.calls, ...first.calls] };
            const out = await client.request({ method: "eth_simulateV1", params: [{ ...opts, blockStateCalls: [seeded, ...rest] }, block] });
            const n = seeding.calls.length;
            const failed = out[0].calls.slice(0, n).findIndex((c) => BigInt(c.status) === 0n);
            assert.equal(failed, -1, `seeding call ${failed} reverted`);
            return [{ ...out[0], calls: out[0].calls.slice(n) }, ...out.slice(1)];
        },
    };
}
const funded = { [SWAPPER]: { balance: `0x${parseEther("1000").toString(16)}` } };

test("live: a 300 BNB swap on PancakeSwap V2 is warded on both sides and its back-run captured", { skip }, async () => {
    const client = seededClient();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const swap = {
        from: SWAPPER,
        to: ROUTER,
        value: parseEther("300"),
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokens", args: [0n, [WBNB, USDT], SWAPPER, deadline] }),
    };
    const plan = await planWards(swap, { client, vanHelsing: bundle.VH_ADDR, overrides: funded });

    const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "-");
    for (const b of plan.bounties) {
        console.log(`  ${b.leg} against ${short(b.anchor)}: ${short(b.token)} bounty ${b.amount} share ${b.share} worth ${b.worthWei} wei for ${b.gasUsed} gas (${b.costWei} wei): ${b.kept ? "kept" : "dropped"}, ${b.note}`);
    }
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.pools.map((p) => p.id), [id(V2_PAIR)], "the swap touched the V2 pair only");
    assert.equal(plan.before.length, 1, "the ward before is insurance");

    const aft = plan.bounties.find((b) => b.leg === "after");
    assert.ok(aft.amount > 0n, "the swap's back-run left a bounty");
    assert.ok([WBNB, USDT].map((a) => a.toLowerCase()).includes(aft.token.toLowerCase()), "paid in a blue chip");
    assert.ok(aft.worthWei > aft.costWei * 2n, "a 300 BNB swap's back-run pays for its ward");
    assert.equal(plan.after.length, 1);
    assert.ok(aft.gasUsed > 100_000n && aft.gasUsed < 2_000_000n, `a ward after's gas is ${aft.gasUsed}`);

    // The ward after restores the pair against the first pool the registry lists after the
    // warded V2 pair: the V3 0.05% pool.
    assert.equal(aft.anchor, id(V3_500));
});

// A wallet that batches the approval with the swap plans the two together: the swap alone,
// before its approval lands, reverts, and a plan of it finds no pool to ward.
test("live: a swap of WBNB it must wrap and approve first is planned with those calls", { skip }, async () => {
    const client = seededClient();
    const amount = parseEther("300");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const wrap = { from: SWAPPER, to: WBNB, value: amount, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "deposit" }) };
    const approve = { from: SWAPPER, to: WBNB, data: encodeFunctionData({ abi: WBNB_ABI, functionName: "approve", args: [ROUTER, amount] }) };
    const swap = {
        from: SWAPPER,
        to: ROUTER,
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactTokensForTokens", args: [amount, 0n, [WBNB, USDT], SWAPPER, deadline] }),
    };
    const opts = { client, vanHelsing: bundle.VH_ADDR, overrides: funded };

    const alone = await planWards(swap, opts);
    assert.equal(alone.reverted, true, "the swap reverts before its wrap and approval");
    assert.deepEqual([alone.pools, alone.before, alone.after], [[], [], []]);

    const plan = await planWards([wrap, approve, swap], opts);
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.pools.map((p) => p.id), [id(V2_PAIR)]);
    assert.equal(plan.swapWorthWei, amount, "worth the 300 BNB it wraps");
    assert.equal(plan.before.length, 1);
    assert.equal(plan.after.length, 1);
    const aft = plan.bounties.find((b) => b.leg === "after");
    assert.ok(aft.amount > 0n && aft.worthWei > aft.costWei * 2n, "the swap's back-run pays for its ward");
});

// eth_simulateV1 stamps a block 12 s after its parent unless told otherwise; BNB Chain makes one
// every 0.45 s. A swap due in 3 s still lands, and is planned.
test("live: a swap due within seconds is planned on the next block", { skip }, async () => {
    const client = seededClient();
    const head = await client.getBlock();
    const swap = {
        from: SWAPPER,
        to: ROUTER,
        value: parseEther("300"),
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokens", args: [0n, [WBNB, USDT], SWAPPER, head.timestamp + 3n] }),
    };
    const plan = await planWards(swap, { client, vanHelsing: bundle.VH_ADDR, overrides: funded });
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.pools.map((p) => p.id), [id(V2_PAIR)]);
    assert.equal(plan.after.length, 1);
});

// An RPC receives the swap signed, raw: planWards decodes it and recovers its sender.
test("live: a signed swap, as an RPC receives it, is planned raw", { skip }, async () => {
    const client = seededClient();
    const signer = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const raw = await signer.signTransaction({
        chainId: 56,
        type: "legacy",
        nonce: 0,
        to: ROUTER,
        value: parseEther("300"),
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokens", args: [0n, [WBNB, USDT], signer.address, deadline] }),
        gas: 500_000n,
        gasPrice: 50_000_000n,
    });
    const plan = await planWards(raw, { client, vanHelsing: bundle.VH_ADDR, overrides: { [signer.address]: { balance: `0x${parseEther("1000").toString(16)}` } } });
    assert.equal(plan.reverted, false);
    assert.equal(plan.payee, signer.address, "the bounty goes back to its signer");
    assert.equal(plan.gasPrice, 50_000_000n, "its own gas price");
    assert.deepEqual(plan.pools.map((p) => p.id), [id(V2_PAIR)]);
    assert.equal(plan.after.length, 1);
});
