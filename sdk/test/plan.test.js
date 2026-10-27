import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAddress, pad, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { planWards } from "../src/plan.js";
import { VANHELSING } from "../src/deployments.js";
import { WARD_ABI, CAPTURED_EVENT } from "../src/ward.js";
import { CHAINS } from "../src/value.js";

const V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNIV3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const V4_MGR = "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// eth_simulateV1 logs a native transfer as a Transfer from this address (traceTransfers)
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const POOLID = "0xa27e05a64e6e5b1d967438c6ce6a2796bb95c7396ca7c40ae35373f37d29b77f";
const ID1 = `0x${"0".repeat(24)}${P1.slice(2)}`;
const ID2 = `0x${"0".repeat(24)}${P2.slice(2)}`;
// the registry's deepest other pool of the pair every listed pool shares
const ANCHOR = `0x${"0".repeat(24)}${"3".repeat(40)}`;
const REG = "0x00000000000000000000000000000000000005e9";
const TA = "0x00000000000000000000000000000000000000a0";
const TB = "0x00000000000000000000000000000000000000b0";
const ZERO = "0x0000000000000000000000000000000000000000";
const VH = "0x000000000000000000000000000000000000dEaD";
const ROUTER = "0x00000000000000000000000000000000000c0FFE";
const SWAPPER = "0x00000000000000000000000000000000000A11cE";
const OTHER = "0x0000000000000000000000000000000000000B0b";
const ODD = "0x0000000000000000000000000000000000000dd0";
const BSC = CHAINS[56];
const WBNB = BSC.wrapped;
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8"; // Binance-Peg ETH
const ETH_FEED = "0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e"; // Chainlink ETH / USD on BNB Chain
const GWEI = 10n ** 9n;
const ONE = 10n ** 18n;
const REGISTRY_ABI = parseAbi([
    "function REGISTRY() view returns (address)",
    "function entryOf(bytes32 id) view returns (uint8 kind, address token0, address token1, uint32 fee, uint64 tax, bool ok)",
    "function poolsFor(address a, address b) view returns (bytes32[])",
]);
const REGISTRY_CALL = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "REGISTRY" });
const FEED_ABI = [{
    type: "function", name: "latestRoundData", inputs: [], stateMutability: "view",
    outputs: [
        { type: "uint80", name: "roundId" }, { type: "int256", name: "answer" }, { type: "uint256", name: "startedAt" },
        { type: "uint256", name: "updatedAt" }, { type: "uint80", name: "answeredInRound" },
    ],
}];

function capturedLog(pool, anchor, payee, token, bounty) {
    return {
        address: VH,
        topics: encodeEventTopics({ abi: [CAPTURED_EVENT], eventName: "Captured", args: { pool, anchor, payee } }),
        data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, bounty]),
    };
}

const swapLog = (pool, topic = V2) => ({ address: pool, topics: [topic] });
// a token the swap moves: a Transfer log, as eth_simulateV1 returns it
const moved = (token, amount, from = ROUTER, to = P1) => ({
    address: token,
    topics: [TRANSFER, pad(from.toLowerCase(), { size: 32 }), pad(to.toLowerCase(), { size: 32 })],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});
const round = (answer) => encodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", result: [1n, answer, 0n, 0n, 1n] });

// A client on chain 56 whose swap logs `logs` (by default a V2 swap on P1 that moves 1 WBNB) and
// whose wards capture what `bounties` says: { "before:<id>" | "after:<id>": [token, amount] }, and
// "after-alone:<id>" for a ward after the swap when no ward ran before it on that pool. Every
// pool shares one pair with ANCHOR in VanHelsing's registry, but for `registry.unlisted` (not
// listed) and `registry.alone` (listed, the only pool of its pair); `registry.broken` makes
// the registry unreadable. `gas` is every ward's gas; `revertAfterWards` makes the swap fail
// once wards ran before it, `revertAfterGap` once a ward that captures something ran before it,
// `needsApproval` until an approval of TA runs before it. The node
// suggests `tip` per gas, on a base fee of `baseFee` for the next block (0 by default, as on BNB
// Chain); `fees` records what it is asked of them. Its head is block `head` (16 by default), made
// at `timestamp`; `times` records the timestamp each simulated block is given. Every account
// holds `balance`; `balances` records whose it is asked.
function client({ logs = [swapLog(P1), moved(WBNB, ONE)], bounties = {}, gas = 380_000n, tip = GWEI / 20n, baseFee = 0n,
    usd = 720n * 10n ** 8n, ethUsd = 2400n * 10n ** 8n, revertAfterWards = false, revertAfterGap = false, needsApproval = false, chainId = 56,
    head = 16n, timestamp = 1_000n, balance = 10n ** 24n, registry = {} } = {}) {
    const seen = [];
    const blocks = [];
    const options = [];
    const fees = [];
    const times = [];
    const balances = [];
    const ok = (status, returnData = "0x", logs = [], gasUsed = "0x5000") => ({ status, returnData, logs, gasUsed });
    const unlisted = registry.unlisted || [];
    const alone = registry.alone || [];
    const lone = (id) => `0x${id.slice(-40)}`; // a lone pool's own second token
    return {
        seen,
        blocks,
        options,
        fees,
        times,
        balances,
        async getChainId() { return chainId; },
        async request({ method, params }) {
            if (method === "eth_getBalance") {
                balances.push(params);
                return `0x${balance.toString(16)}`;
            }
            if (method === "eth_getBlockByNumber") {
                const number = params[0] === "latest" ? head : BigInt(params[0]);
                return { number: `0x${number.toString(16)}`, timestamp: `0x${timestamp.toString(16)}` };
            }
            if (method === "eth_feeHistory" || method === "eth_maxPriorityFeePerGas") {
                fees.push({ method, params });
                const hex = (n) => `0x${n.toString(16)}`;
                return method === "eth_feeHistory" ? { baseFeePerGas: [hex(baseFee), hex(baseFee)] } : hex(tip);
            }
            assert.equal(method, "eth_simulateV1");
            const calls = params[0].blockStateCalls[0].calls;
            seen.push(calls);
            blocks.push(params[1]);
            options.push(params[0]);
            times.push(params[0].blockStateCalls[0].blockOverrides?.time);
            const swapAt = calls.findIndex((c) => same(c.to, ROUTER));
            const wardedBefore = new Set(calls.slice(0, Math.max(swapAt, 0)).filter(isWard)
                .map((c) => decodeFunctionData({ abi: WARD_ABI, data: c.data }).args[0]));
            return [{
                calls: calls.map((c, i) => {
                    if (same(c.to, ROUTER)) {
                        const approved = calls.slice(0, i).some((x) => same(x.to, TA) && x.data.startsWith(APPROVE));
                        if (needsApproval && !approved) return ok("0x0", "0x", [], "0x5000");
                        const gapped = [...wardedBefore].some((id) => bounties[`before:${id}`]);
                        const reverts = (revertAfterWards && wardedBefore.size > 0) || (revertAfterGap && gapped);
                        return ok(reverts ? "0x0" : "0x1", "0x", logs, "0x30000");
                    }
                    if (same(c.to, BSC.usdFeed)) return ok("0x1", round(usd));
                    if (same(c.to, ETH_FEED)) return ok("0x1", round(ethUsd));
                    if (same(c.to, VH) && c.data === REGISTRY_CALL) {
                        return registry.broken ? ok("0x0") : ok("0x1", encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "REGISTRY", result: REG }));
                    }
                    if (same(c.to, REG)) {
                        const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: c.data });
                        if (functionName === "entryOf") {
                            const listed = !unlisted.includes(args[0]);
                            const [t0, t1] = !listed ? [ZERO, ZERO] : alone.includes(args[0]) ? [TA, lone(args[0])] : [TA, TB];
                            return ok("0x1", encodeFunctionResult({ abi: REGISTRY_ABI, functionName, result: [listed ? 2 : 0, t0, t1, 500, 0n, listed] }));
                        }
                        const only = alone.find((id) => args.some((a) => same(a, lone(id))));
                        return ok("0x1", encodeFunctionResult({ abi: REGISTRY_ABI, functionName, result: only ? [only] : [ANCHOR, ID1, ID2, POOLID] }));
                    }
                    if (!same(c.to, VH)) return ok("0x1"); // an approval, a wrap: calls the swap needs
                    const [id, payee] = decodeFunctionData({ abi: WARD_ABI, data: c.data }).args;
                    const leg = i < swapAt ? "before" : "after";
                    const first = leg === "after" && !wardedBefore.has(id) ? bounties[`after-alone:${id}`] : undefined;
                    const b = first ?? bounties[`${leg}:${id}`];
                    return ok("0x1", "0x", b ? [capturedLog(id, ANCHOR, payee, b[0], b[1])] : [], `0x${gas.toString(16)}`);
                }),
            }];
        },
    };
}

// The simulation that evaluated the plan: the last one with the swap and more besides.
const evaluation = (c) => c.seen.filter((calls) => calls.length > 1 && calls.some((x) => x.to === ROUTER)).at(-1);

const swap = (from = SWAPPER) => ({ to: ROUTER, data: "0xdeadbeef", from });
// approve(ROUTER, max) on TA, the token the swap pays
const APPROVE = "0x095ea7b3";
const approve = (from = SWAPPER) => ({ to: TA, data: `${APPROVE}${pad(ROUTER.toLowerCase(), { size: 32 }).slice(2)}${"f".repeat(64)}`, from });
// ward(id, payee): the payee is the second argument's low 20 bytes
const recipient = (call) => `0x${call.data.slice(10 + 64 + 24, 10 + 128)}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const isWard = (c) => same(c.to, VH) && c.data !== REGISTRY_CALL;

test("planWards: finds the pools across V2/V3/V4, insures the swap with a ward before each and keeps the wards after it worth their gas", async () => {
    const c = client({
        logs: [swapLog(P1), swapLog(P2, UNIV3), { address: V4_MGR, topics: [V4, POOLID] }, moved(WBNB, ONE)],
        // 0.01 WBNB of back-run at P1, dust at P2, nothing at the V4 pool
        bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n], [`after:${ID2}`]: [WBNB, 10n ** 12n] },
    });
    const plan = await planWards(swap(), { client: c, vanHelsing: VH, after: "profitable" });
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.pools.map((p) => p.kind), [0, 2, 4]);
    assert.equal(plan.pools[2].id, POOLID);
    assert.equal(plan.before.length, 3, "three wards before cost 0.005% of the 1 WBNB the swap moves");
    assert.equal(plan.swapWorthWei, ONE);
    assert.deepEqual(plan.after.map((s) => s.id), [ID1], "only the ward after worth its gas");
    assert.ok([...plan.before, ...plan.after].every((s) => s.to === VH && recipient(s) === SWAPPER.toLowerCase()));

    const [after1, after2, after3] = plan.bounties.filter((b) => b.leg === "after");
    assert.equal(after1.amount, 10n ** 16n);
    assert.equal(after1.share, 9n * 10n ** 15n, "the swapper's 90%");
    assert.equal(after1.costWei, 380_000n * (GWEI / 20n));
    assert.match(after1.note, /^worth \d+\.\dx its gas$/);
    assert.equal(after2.kept, false);
    assert.equal(after2.note, "worth less than its gas");
    assert.equal(after3.note, "nothing to capture");
    assert.ok(plan.bounties.filter((b) => b.leg === "before").every((b) => b.kept && b.note === "insurance: 0.005% of the swap"));
    assert.equal(plan.gasPrice, GWEI / 20n);

    // The plan is evaluated as [before, swap, after, feeds], in that order.
    assert.deepEqual(evaluation(c).map((x) => x.to.toLowerCase()), [VH, VH, VH, ROUTER, VH, VH, VH, BSC.usdFeed, ETH_FEED].map((a) => a.toLowerCase()));
});

test("planWards: prices a stablecoin bounty with the chain's BNB/USD feed", async () => {
    const cents = (n) => 10n ** 16n * n; // USDT has 18 decimals
    const plan = await planWards(swap(), { client: client({ bounties: { [`after:${ID1}`]: [USDT, cents(5n)] } }), vanHelsing: VH });
    const [b] = plan.bounties.filter((x) => x.leg === "after");
    // the swapper's 4.5 cents at $720 per BNB, against 380k gas at 0.05 gwei (0.000019 BNB)
    assert.equal(b.worthWei, (cents(5n) * 9n / 10n) * 10n ** 8n / (720n * 10n ** 8n));
    assert.equal(b.kept, true);

    const poorer = await planWards(swap(), { client: client({ bounties: { [`after:${ID1}`]: [USDT, cents(1n)] } }), vanHelsing: VH, after: "profitable" });
    assert.equal(poorer.after.length, 0, "a cent does not pay for the ward after");
});

test("planWards: drops a bounty it cannot price, unless value says what it is worth", async () => {
    const bounties = { [`after:${ID1}`]: [ODD, 10n ** 18n] };
    const plan = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, after: "profitable" });
    assert.equal(plan.after.length, 0);
    assert.match(plan.bounties.find((b) => b.leg === "after").note, /no price for .*: pass value/);

    const value = async (token, amount) => (token.toLowerCase() === ODD ? amount / 1000n : undefined);
    const priced = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, value });
    assert.equal(priced.after.length, 1);
    assert.equal(priced.bounties.find((b) => b.leg === "after").worthWei, 9n * 10n ** 14n);
});

test("planWards: the policies", async () => {
    const bounties = { [`before:${ID1}`]: [WBNB, 10n ** 16n], [`after:${ID1}`]: [WBNB, 10n ** 13n] };
    const none = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, before: "never", after: "always" });
    assert.equal(none.before.length, 0);
    assert.equal(none.after.length, 1, "always sends the ward after, dust or not");
    assert.equal(none.bounties.filter((b) => b.leg === "before").length, 0, "a ward not sent is not simulated");

    const gap = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, before: "profitable" });
    assert.equal(gap.before.length, 1, "a standing gap pays for its ward");
    const noGap = await planWards(swap(), { client: client({}), vanHelsing: VH, before: "profitable" });
    assert.equal(noGap.before.length, 0);

    // 1e13 * 0.9 = 9e12 wei against 380k gas at 0.05 gwei = 1.9e13 wei: it nets -1e13
    const lenient = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, after: "profitable", minProfit: -(10n ** 13n) - 1n });
    assert.equal(lenient.after.length, 1, "a negative minProfit accepts a ward that nets less than its gas");

    const quiet = client({ bounties });
    const off = await planWards(swap(), { client: quiet, vanHelsing: VH, before: "never", after: "never" });
    assert.deepEqual([off.before, off.after, off.bounties], [[], [], []]);
    assert.equal(quiet.seen.length, 1, "nothing to weigh, nothing simulated past the pools");

    await assert.rejects(() => planWards(swap(), { client: client(), vanHelsing: VH, after: "sometimes" }), /after must be one of/);
});

// The ward after the swap meets the pool the bundle leaves it: a ward before that is not sent
// leaves its gap there, which the swap and the ward after then meet.
test("planWards: weighs the wards after the swap on the bundle it sends", async () => {
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 13n], [`after-alone:${ID1}`]: [WBNB, 10n ** 16n] };
    const c = client({ bounties });
    const plan = await planWards(swap(), { client: c, vanHelsing: VH, before: "profitable" });
    assert.equal(plan.before.length, 0, "the ward before finds nothing to capture");
    assert.equal(plan.after.length, 1, "behind no ward before, the ward after pays");
    assert.equal(plan.bounties.find((b) => b.leg === "after").amount, 10n ** 16n);
    const sent = evaluation(c);
    assert.equal(sent.findIndex((x) => x.to === ROUTER), 0, "weighed on the swap with no ward before it");
});

test("planWards: builds every simulation on one block", async () => {
    const c = client({ head: 123n, bounties: { [`after:${ID1}`]: [WBNB, 10n ** 17n] } });
    await planWards(swap(), { client: c, vanHelsing: VH });
    assert.ok(c.blocks.length > 1);
    assert.ok(c.blocks.every((b) => b === "0x7b"), `blocks: ${c.blocks}`);
    const pinned = client({ head: 123n });
    await planWards(swap(), { client: pinned, vanHelsing: VH, block: 99n });
    assert.ok(pinned.blocks.every((b) => b === "0x63"));
    const baseFeeAt = (c) => c.fees.find((f) => f.method === "eth_feeHistory").params[1];
    assert.deepEqual([baseFeeAt(c), baseFeeAt(pinned)], ["0x7b", "0x63"], "the gas price is read on that block too");
});

test("planWards: weighs the wards at the swap's own gas price, which the plan reports", async () => {
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    const legacy = client({ bounties });
    const plan = await planWards({ ...swap(), gasPrice: GWEI }, { client: legacy, vanHelsing: VH });
    assert.equal(plan.gasPrice, GWEI);
    assert.ok(plan.bounties.length > 0 && plan.bounties.every((b) => b.costWei === b.gasUsed * GWEI));
    assert.deepEqual(legacy.fees, [], "a swap that names its price needs nothing from the node");

    const dynamic = client({ bounties, baseFee: GWEI / 10n });
    const tipped = await planWards({ ...swap(), maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 50n }, { client: dynamic, vanHelsing: VH });
    assert.equal(tipped.gasPrice, GWEI / 10n + GWEI / 50n, "the next block's base fee plus the swap's tip");
    assert.deepEqual(dynamic.fees.map((f) => f.method), ["eth_feeHistory"]);

    const unpriced = await planWards(swap(), { client: client({ bounties, baseFee: GWEI / 10n }), vanHelsing: VH });
    assert.equal(unpriced.gasPrice, GWEI / 10n + GWEI / 20n, "the node's suggested tip fills the swap's");
});

test("planWards: gasPrice overrides the swap's own price, as a bigint or a number", async () => {
    const c = client({ bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const plan = await planWards({ ...swap(), gasPrice: GWEI }, { client: c, vanHelsing: VH, gasPrice: 7 });
    assert.equal(plan.gasPrice, 7n);
    assert.ok(plan.bounties.every((b) => b.costWei === b.gasUsed * 7n));
    assert.deepEqual(c.fees, []);
});

test("planWards: takes no anchors option: the registry's deepest pool always anchors", async () => {
    for (const opt of [{ anchors: "best" }, { maxAnchors: 3 }]) {
        await assert.rejects(planWards(swap(), { client: client(), vanHelsing: VH, ...opt }), /anchors option is gone/);
    }
    const plan = await planWards(swap(), { client: client({ bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } }), vanHelsing: VH });
    for (const call of [...plan.before, ...plan.after]) {
        assert.equal(decodeFunctionData({ abi: WARD_ABI, data: call.data }).args.length, 2);
    }
});

test("planWards: never sends a ward that would burn its gas and capture nothing", async () => {
    const c = client({ bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const burn = c.request;
    c.request = async (args) => {
        if (args.method !== "eth_simulateV1") return burn(args);
        const out = await burn(args);
        const calls = args.params[0].blockStateCalls[0].calls;
        const swapAt = calls.findIndex((x) => same(x.to, ROUTER));
        out[0].calls.forEach((r, i) => { if (i < swapAt) r.gasUsed = `0x${(12_000_000n).toString(16)}`; });
        return out;
    };
    const plan = await planWards(swap(), { client: c, vanHelsing: VH });
    assert.equal(plan.before.length, 0);
    assert.match(plan.bounties.find((b) => b.leg === "before").note, /would burn 12000000 gas and capture nothing/);
    assert.equal(plan.after.length, 1, "the ward after is weighed on its own");

    // and the same goes for a ward after the swap, even sent always
    const late = client();
    const lateBurn = late.request;
    late.request = async (args) => {
        if (args.method !== "eth_simulateV1") return lateBurn(args);
        const out = await lateBurn(args);
        const calls = args.params[0].blockStateCalls[0].calls;
        const swapAt = calls.findIndex((x) => same(x.to, ROUTER));
        out[0].calls.forEach((r, i) => { if (i > swapAt && same(calls[i].to, VH)) r.gasUsed = `0x${(12_000_000n).toString(16)}`; });
        return out;
    };
    const always = await planWards(swap(), { client: late, vanHelsing: VH, after: "always" });
    assert.equal(always.after.length, 0);
    assert.match(always.bounties.find((b) => b.leg === "after").note, /would burn 12000000 gas and capture nothing/);
});

// A ward before that captures a gap in the swap's favor pays it to the recipient and gives the
// swap the fair price. It is left out only when the swap then reverts, its quote counting on
// that gap: the wards before that capture nothing cannot fail the swap, and still undo a
// front-run.
test("planWards: keeps a ward before that captures a gap in the swap's favor while the swap still goes", async () => {
    const bounties = { [`before:${ID1}`]: [WBNB, 10n ** 16n], [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    const plan = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH });
    assert.deepEqual(plan.before.map((w) => w.id), [ID1]);
    assert.equal(plan.beforeDropped, undefined);
});

test("planWards: leaves out only the wards before that capture a gap, when the swap reverts after them", async () => {
    const logs = [swapLog(P1), swapLog(P2, UNIV3), moved(WBNB, ONE)];
    const bounties = { [`before:${ID1}`]: [WBNB, 10n ** 16n], [`after:${ID1}`]: [WBNB, 10n ** 16n], [`after:${ID2}`]: [WBNB, 10n ** 16n] };
    const c = client({ logs, bounties, revertAfterGap: true });
    const plan = await planWards(swap(), { client: c, vanHelsing: VH });
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.before.map((w) => w.id), [ID2], "the ward that captures nothing still insures the swap");
    assert.match(plan.beforeDropped, /its quote counts on the gap they capture/);
    const gap = plan.bounties.find((b) => b.leg === "before" && b.id === ID1);
    assert.equal(gap.kept, false);
    assert.match(gap.note, /^left out: the swap reverts after it/);
    assert.deepEqual(plan.after.map((w) => w.id), [ID1, ID2]);
    // weighed on the bundle that is sent: the insurance, the swap, the wards after
    assert.deepEqual(evaluation(c).map((x) => x.to.toLowerCase()), [VH, ROUTER, VH, VH, BSC.usdFeed, ETH_FEED].map((a) => a.toLowerCase()));

    // a swap that reverts after any ward before goes with none
    const any = await planWards(swap(), { client: client({ logs, bounties, revertAfterWards: true }), vanHelsing: VH });
    assert.equal(any.reverted, false);
    assert.deepEqual(any.before, []);
    assert.ok(plan.beforeDropped && any.beforeDropped);
    assert.deepEqual(any.after.map((w) => w.id), [ID1, ID2]);

    // a ward the policy does not send cannot fail the swap
    const lean = await planWards(swap(), {
        client: client({ revertAfterWards: true, bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } }),
        vanHelsing: VH,
        before: "profitable",
    });
    assert.equal(lean.beforeDropped, undefined);
    assert.deepEqual([lean.before.length, lean.after.length], [0, 1]);
});

test("planWards: a swap that reverts on its own gets no wards", async () => {
    const c = {
        async getChainId() { return 56; },
        async request({ method, params }) {
            if (method === "eth_getBlockByNumber") return { number: "0x10", timestamp: "0x3e8" };
            if (method === "eth_feeHistory") return { baseFeePerGas: ["0x0", "0x0"] };
            if (method === "eth_maxPriorityFeePerGas") return "0x2faf080";
            if (method === "eth_getBalance") return "0xd3c21bcecceda1000000";
            const calls = params[0].blockStateCalls[0].calls;
            return [{ calls: calls.map((x) => (same(x.to, ROUTER) ? { status: "0x0", logs: [{ address: P1, topics: [V2] }] } : { status: "0x1", logs: [] })) }];
        },
    };
    const plan = await planWards(swap(), { client: c, vanHelsing: VH });
    assert.equal(plan.reverted, true);
    assert.deepEqual([plan.before, plan.after], [[], []]);
});

test("planWards: pays the bounties to the swapper unless told otherwise", async () => {
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    const mine = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH });
    assert.ok([...mine.before, ...mine.after].every((h) => recipient(h) === SWAPPER.toLowerCase()));
    assert.equal(mine.payee, SWAPPER);
    const theirs = await planWards(swap(), { client: client({ bounties }), vanHelsing: VH, payee: OTHER });
    assert.ok([...theirs.before, ...theirs.after].every((h) => recipient(h) === OTHER.toLowerCase()));
    const anyone = await planWards({ to: ROUTER, data: "0x" }, { client: client({ bounties }), vanHelsing: VH, after: "always" });
    assert.ok([...anyone.before, ...anyone.after].every((h) => /^0x0{40}$/.test(recipient(h))), "no sender: the contract pays whoever calls");
});

test("planWards: refuses a to option: the bounties go to payee", async () => {
    await assert.rejects(() => planWards(swap(), { client: client(), vanHelsing: VH, to: OTHER }), /to is now payee/);
});

test("planWards: resolves the VanHelsing address from the deployments table by chain", async () => {
    VANHELSING[31337] = VH; // simulate a known deployment on this chain
    try {
        const plan = await planWards(swap(), { client: client({ chainId: 31337 }), after: "always" });
        assert.equal(plan.vanHelsing, VH);
        assert.ok(plan.after.length > 0);
        assert.ok([...plan.before, ...plan.after].every((h) => h.to === VH));
    } finally {
        delete VANHELSING[31337];
    }
});

test("planWards: on BNB Chain, the wards call the deployed proxy", async () => {
    const plan = await planWards(swap(), { client: client() });
    assert.equal(plan.vanHelsing, "0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25");
});

test("planWards: throws a clear error when no deployment is known and no override", async () => {
    await assert.rejects(() => planWards(swap(), { client: client({ chainId: 31337 }) }), /planWards: no known VanHelsing deployment for chain 31337/);
});

// 0.9 of 3.2e13 = 2.88e13 wei against 380k gas at 0.05 gwei = 1.9e13 wei: 1.5x, netting 9.8e12
const backRun = { [`after:${ID1}`]: [WBNB, 32n * 10n ** 12n] };

test("planWards: keeps a ward after that nets anything over its gas", async () => {
    const plan = await planWards(swap(), { client: client({ bounties: backRun }), vanHelsing: VH });
    assert.deepEqual(plan.after.map((s) => s.id), [ID1]);
    assert.equal(plan.bounties.find((b) => b.leg === "after").note, "worth 1.5x its gas");
});

test("planWards: minProfit is the least a ward must net after its gas", async () => {
    const high = await planWards(swap(), { client: client({ bounties: backRun }), vanHelsing: VH, after: "profitable", minProfit: 10n ** 13n });
    assert.equal(high.after.length, 0);
    assert.equal(high.bounties.find((b) => b.leg === "after").note, "nets less than minProfit after its gas");
    const low = await planWards(swap(), { client: client({ bounties: backRun }), vanHelsing: VH, after: "profitable", minProfit: 9n * 10n ** 12n });
    assert.equal(low.after.length, 1);
});

test("planWards: minProfitRatio is gone", async () => {
    await assert.rejects(planWards(swap(), { client: client(), vanHelsing: VH, minProfitRatio: 2 }), /minProfitRatio is gone: pass minProfit/);
});

test("planWards: insures the swap when its wards before cost at most maxPremium of what it moves", async () => {
    const plan = await planWards(swap(), { client: client(), vanHelsing: VH });
    assert.equal(plan.swapWorthWei, ONE);
    assert.deepEqual(plan.before.map((s) => s.id), [ID1]);
    assert.equal(plan.bounties.find((b) => b.leg === "before").note, "insurance: 0.001% of the swap");
    const big = await planWards(swap(), { client: client({ logs: [swapLog(P1), moved(WBNB, 10n * ONE)] }), vanHelsing: VH });
    assert.equal(big.bounties.find((b) => b.leg === "before").note, "insurance: under 0.001% of the swap");
});

test("planWards: leaves the insurance out when it costs more than maxPremium of the swap", async () => {
    // 1.9e13 wei of gas on a swap that moves 0.001 WBNB: 1.9%
    const small = { logs: [swapLog(P1), moved(WBNB, 10n ** 15n)] };
    const plan = await planWards(swap(), { client: client(small), vanHelsing: VH });
    assert.equal(plan.before.length, 0);
    assert.equal(plan.bounties.find((b) => b.leg === "before").note, "insurance would cost 1.900% of the swap, more than maxPremium allows");
    const generous = await planWards(swap(), { client: client(small), vanHelsing: VH, maxPremium: 0.02 });
    assert.equal(generous.before.length, 1);
    assert.equal(generous.bounties.find((b) => b.leg === "before").note, "insurance: 1.900% of the swap");
});

test("planWards: insures by default while the wards before cost at most 0.5% of the swap", async () => {
    // 1.9e13 wei of gas: 0.447% of a swap that moves 4.25e15 wei of WBNB, 0.551% of one that moves 3.45e15
    const at = (amount) => planWards(swap(), { client: client({ logs: [swapLog(P1), moved(WBNB, amount)] }), vanHelsing: VH });
    assert.equal((await at(4_250n * 10n ** 12n)).before.length, 1);
    assert.equal((await at(3_450n * 10n ** 12n)).before.length, 0);
});

test("planWards: keeps a ward before that pays for itself, however small the swap", async () => {
    const plan = await planWards(swap(), {
        client: client({ logs: [swapLog(P1), swapLog(P2, UNIV3), moved(WBNB, 10n ** 15n)], bounties: { [`before:${ID1}`]: [WBNB, 10n ** 16n] } }),
        vanHelsing: VH,
    });
    assert.deepEqual(plan.before.map((s) => s.id), [ID1], "the gap pays for its ward; the other ward is insurance the swap is too small for");
    assert.match(plan.bounties.find((b) => b.leg === "before" && b.id === ID1).note, /^worth \d+\.\dx its gas$/);
});

test("planWards: values the swap from the native token it sends or moves", async () => {
    const sent = await planWards({ ...swap(), value: ONE }, { client: client({ logs: [swapLog(P1)] }), vanHelsing: VH });
    assert.equal(sent.swapWorthWei, ONE);
    assert.equal(sent.before.length, 1);
    const traced = await planWards(swap(), { client: client({ logs: [swapLog(P1), moved(NATIVE, 2n * ONE)] }), vanHelsing: VH });
    assert.equal(traced.swapWorthWei, 2n * ONE);
});

test("planWards: asks the RPC for the swap's native transfers", async () => {
    const c = client();
    await planWards(swap(), { client: c, vanHelsing: VH });
    assert.equal(c.options[0].traceTransfers, true);
});

test("planWards: values a stablecoin leg of the swap at the chain's feed price", async () => {
    const plan = await planWards(swap(), { client: client({ logs: [swapLog(P1), moved(USDT, 100n * ONE)] }), vanHelsing: VH });
    assert.equal(plan.swapWorthWei, (100n * ONE * 10n ** 8n) / (720n * 10n ** 8n));
});

test("planWards: cannot value a swap that moves no hub token, so leaves the insurance out and says why", async () => {
    const odd = { logs: [swapLog(P1), moved(ODD, ONE)] };
    const plan = await planWards(swap(), { client: client(odd), vanHelsing: VH });
    assert.equal(plan.swapWorthWei, null);
    assert.equal(plan.before.length, 0);
    assert.match(plan.bounties.find((b) => b.leg === "before").note, /no price for the swap/);
    const priced = await planWards(swap(), { client: client(odd), vanHelsing: VH, value: async (token, amount) => (same(token, ODD) ? amount : undefined) });
    assert.equal(priced.swapWorthWei, ONE);
    assert.equal(priced.before.length, 1);
});

test("planWards: sends a ward only where VanHelsing can anchor its pool, whatever the policy", async () => {
    const logs = [swapLog(P1), swapLog(P2, UNIV3), { address: V4_MGR, topics: [V4, POOLID] }, moved(WBNB, ONE)];
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    const registry = { unlisted: [ID2], alone: [POOLID] };
    const c = client({ logs, bounties, registry });
    const plan = await planWards(swap(), { client: c, vanHelsing: VH });
    assert.deepEqual(plan.before.map((s) => s.id), [ID1]);
    assert.deepEqual(plan.after.map((s) => s.id), [ID1]);
    const bundles = c.seen.filter((calls) => calls.some((x) => same(x.to, ROUTER))).length;
    assert.equal(bundles, 2, "the swap alone, then one bundle: leaving out wards that do nothing needs no second look");
    for (const leg of ["before", "after"]) {
        assert.equal(plan.bounties.find((b) => b.leg === leg && b.id === ID2).note, "VanHelsing does not list this pool, so its ward captures nothing");
        assert.equal(plan.bounties.find((b) => b.leg === leg && b.id === POOLID).note, "VanHelsing lists no other pool of its pair to anchor it, so its ward captures nothing");
    }

    // always too: a ward with no other pool of its pair to anchor against can do nothing
    const always = await planWards(swap(), { client: client({ logs, bounties, registry }), vanHelsing: VH, before: "always", after: "always" });
    assert.deepEqual(always.before.map((s) => s.id), [ID1]);
    assert.deepEqual(always.after.map((s) => s.id), [ID1]);
    for (const leg of ["before", "after"]) {
        assert.equal(always.bounties.find((b) => b.leg === leg && b.id === ID2).note, "VanHelsing does not list this pool, so its ward captures nothing");
        assert.equal(always.bounties.find((b) => b.leg === leg && b.id === POOLID).note, "VanHelsing lists no other pool of its pair to anchor it, so its ward captures nothing");
    }

    const unread = await planWards(swap(), { client: client({ logs, registry: { ...registry, broken: true } }), vanHelsing: VH });
    assert.equal(unread.before.length, 3, "a registry it cannot read drops nothing");
    const garbled = client({ logs, registry });
    const answer = garbled.request;
    garbled.request = async (args) => {
        if (args.method !== "eth_simulateV1") return answer(args);
        const out = await answer(args);
        const calls = args.params[0].blockStateCalls[0].calls;
        out[0].calls.forEach((r, i) => { if (same(calls[i].to, REG)) r.returnData = "0x1234"; });
        return out;
    };
    const odd = await planWards(swap(), { client: garbled, vanHelsing: VH });
    assert.equal(odd.before.length, 3, "nor does one that answers like no registry");
});

test("planWards: prices an ETH bounty on BNB Chain through ETH's own feed", async () => {
    const plan = await planWards(swap(), { client: client({ bounties: { [`after:${ID1}`]: [ETH, 10n ** 16n] } }), vanHelsing: VH });
    const b = plan.bounties.find((x) => x.leg === "after");
    // the swapper's 0.009 ETH at $2,400, in BNB at $720
    assert.equal(b.worthWei, 3n * 10n ** 16n);
    assert.equal(b.kept, true);
});

test("planWards: reads the registry before the swap, so a swap that burns all its gas cannot starve the read", async () => {
    const c = client();
    await planWards(swap(), { client: c, vanHelsing: VH });
    assert.equal(c.seen[0][0].data, REGISTRY_CALL);
    assert.ok(same(c.seen[0][1].to, ROUTER));
});

test("planWards: values the swap at what its sender pays or receives, over every leg and net of refunds", async () => {
    // a route that pulls 0.005 WBNB from the sender for each of two pools
    const legs = [swapLog(P1), swapLog(P2, UNIV3), moved(WBNB, 5n * 10n ** 15n, SWAPPER, P1), moved(WBNB, 5n * 10n ** 15n, SWAPPER, P2)];
    assert.equal((await planWards(swap(), { client: client({ logs: legs }), vanHelsing: VH })).swapWorthWei, 10n ** 16n);
    // 1 BNB sent, 0.2 BNB refunded
    const refund = [swapLog(P1), moved(NATIVE, ONE, SWAPPER, ROUTER), moved(NATIVE, 2n * 10n ** 17n, ROUTER, SWAPPER)];
    assert.equal((await planWards({ ...swap(), value: ONE }, { client: client({ logs: refund }), vanHelsing: VH })).swapWorthWei, 8n * 10n ** 17n);
});

test("planWards: asks value once per token, with checksummed addresses, and takes a number back as wei", async () => {
    const asked = [];
    const value = async (token, amount) => {
        asked.push(token);
        return same(token, ODD) ? Number(amount) : undefined;
    };
    const logs = [swapLog(P1), moved(ODD, ONE, ROUTER, P1), moved(ODD, ONE / 2n, P1, ROUTER)];
    const plan = await planWards(swap(), { client: client({ logs, bounties: { [`after:${ID1}`]: [ODD, 10n ** 16n] } }), vanHelsing: VH, value });
    assert.equal(plan.swapWorthWei, ONE);
    assert.ok(asked.every((t) => t === getAddress(t)), `asked ${asked}`);
    assert.equal(asked.filter((t) => same(t, ODD)).length, 2, "once for the swap, once for the bounty");
    assert.equal(plan.bounties.find((b) => b.leg === "after").worthWei, 9n * 10n ** 15n);

    const failing = async (token) => {
        if (same(token, ODD)) throw new Error("no quote");
        return undefined;
    };
    const unpriced = await planWards(swap(), { client: client({ logs }), vanHelsing: VH, value: failing });
    assert.equal(unpriced.swapWorthWei, null, "a value that throws on the swap's token leaves the swap unvalued");
});

test("planWards: by default keeps a ward after while it costs little, for a back-run the market may open by then", async () => {
    const plan = await planWards(swap(), { client: client(), vanHelsing: VH });
    assert.deepEqual(plan.after.map((s) => s.id), [ID1]);
    // its 1.9e13 wei with the ward before's 1.9e13: 0.003% of the 1 WBNB the swap moves
    assert.equal(plan.bounties.find((b) => b.leg === "after").note, "affordable: 0.003% of the swap, with the insurance before it");
    const alone = await planWards(swap(), { client: client(), vanHelsing: VH, before: "never" });
    assert.equal(alone.bounties.find((b) => b.leg === "after").note, "affordable: 0.001% of the swap");
    const strict = await planWards(swap(), { client: client(), vanHelsing: VH, after: "profitable" });
    assert.equal(strict.after.length, 0);
});

test("planWards: the wards before and after share maxPremium, the wards before first", async () => {
    // 1.9e13 wei of gas each on a swap that moves 4.75e15 wei: the ward before alone is 0.4%, both 0.8%
    const logs = [swapLog(P1), moved(WBNB, 4_750n * 10n ** 12n)];
    const plan = await planWards(swap(), { client: client({ logs }), vanHelsing: VH });
    assert.equal(plan.before.length, 1);
    assert.equal(plan.after.length, 0);
    assert.equal(plan.bounties.find((b) => b.leg === "after").note, "would cost 0.800% of the swap with the insurance before it, more than maxPremium allows");
    const roomier = await planWards(swap(), { client: client({ logs }), vanHelsing: VH, maxPremium: 0.01 });
    assert.equal(roomier.after.length, 1);
});

test("planWards: needs a client, a chain or a chainId", async () => {
    await assert.rejects(planWards(swap(), { vanHelsing: VH }), /planWards: pass a client, a chain \(bsc or ethereum\) or a chainId \(56 or 1\)/);
    await assert.rejects(planWards(swap(), { vanHelsing: VH, chain: "bsc", chainId: 1 }), /planWards: chain bsc is not chainId 1/);
});

// A wallet that batches an approval with the swap sends both, in order: the swap alone, planned
// before the approval lands, reverts, and a plan of it finds no pool.
test("planWards: plans the calls a swap needs, its approval first, with the wards around all of them", async () => {
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    const lone = await planWards(swap(), { client: client({ needsApproval: true, bounties }), vanHelsing: VH });
    assert.equal(lone.reverted, true);
    assert.deepEqual([lone.pools, lone.before, lone.after], [[], [], []]);

    const c = client({ needsApproval: true, bounties });
    const plan = await planWards([approve(), { ...swap(), gasPrice: GWEI }], { client: c, vanHelsing: VH });
    assert.equal(plan.reverted, false);
    assert.deepEqual(plan.pools.map((p) => p.id), [ID1]);
    assert.equal(plan.payee, SWAPPER, "the bounties go to the calls' sender");
    assert.equal(plan.gasPrice, GWEI, "weighed at the swap's own price");
    assert.deepEqual([plan.before.length, plan.after.length], [1, 1]);
    assert.ok([...plan.before, ...plan.after].every((w) => recipient(w) === SWAPPER.toLowerCase()));
    // evaluated as it is sent: [...before, approval, swap, ...after], then the price feeds
    assert.deepEqual(evaluation(c).map((x) => x.to.toLowerCase()), [VH, TA, ROUTER, VH, BSC.usdFeed, ETH_FEED].map((a) => a.toLowerCase()));
});

test("planWards: values a batch at what all of its calls send", async () => {
    const wrap = { to: WBNB, data: "0xd0e30db0", value: ONE, from: SWAPPER };
    const plan = await planWards([wrap, swap()], { client: client({ logs: [swapLog(P1)] }), vanHelsing: VH });
    assert.equal(plan.swapWorthWei, ONE);
    assert.equal(plan.before.length, 1);
});

test("planWards: refuses an empty batch", async () => {
    await assert.rejects(planWards([], { client: client(), vanHelsing: VH }), /planWards: pass the swap, or the calls that make it, in order/);
});

// eth_simulateV1 puts a block 12 s after its parent unless told otherwise: on BNB Chain, which
// makes one every 0.45 s, a swap whose deadline or quote runs out sooner would revert there.
test("planWards: simulates the block after the head as BNB Chain makes it, a second later", async () => {
    const c = client({ head: 123n, timestamp: 1_000n, bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    await planWards(swap(), { client: c, vanHelsing: VH });
    assert.ok(c.times.length > 2 && c.times.every((t) => t === "0x3e9"), `times: ${c.times}`);
    assert.ok(c.blocks.every((b) => b === "0x7b"));
});

// The chain charges every transaction its gas at a price, and a contract can read that price
// (tx.gasprice): a simulation at 0 is not the chain the swap is sent to.
const MAX_TX_GAS = 16_777_216n;
const quantity = (n) => `0x${BigInt(n).toString(16)}`;

// A swap's gas limit was estimated for the state it was to meet. Planned on another, it can need
// more, and that is its sender's to check, not the plan's: the plan gives every call it sends
// the most gas a transaction may use.
test("planWards: simulates the swap and its wards at the swap's own gas price, within the most gas a transaction may use", async () => {
    const c = client({ bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const plan = await planWards({ ...swap(), gasPrice: GWEI, gas: 300_000n }, { client: c, vanHelsing: VH });
    assert.equal(plan.gasPrice, GWEI);
    assert.ok(c.seen.length > 1);
    for (const x of c.seen.flat()) {
        if (same(x.to, ROUTER) || isWard(x)) assert.deepEqual([x.gasPrice, x.gas], [quantity(GWEI), quantity(MAX_TX_GAS)]);
        else assert.equal(x.gasPrice, undefined, "a read the plan does not send runs at 0");
    }
    // a swap that names more keeps it
    const big = client();
    await planWards({ ...swap(), gas: 2n * MAX_TX_GAS }, { client: big, vanHelsing: VH });
    assert.equal(big.seen[0].find((x) => same(x.to, ROUTER)).gas, quantity(2n * MAX_TX_GAS));

    // an EIP-1559 swap runs at the price it pays, the next block's base fee plus its tip
    const dynamic = client({ baseFee: GWEI / 10n });
    await planWards({ ...swap(), maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 50n }, { client: dynamic, vanHelsing: VH });
    const sent = dynamic.seen[0].find((x) => same(x.to, ROUTER));
    assert.deepEqual([sent.gasPrice, sent.maxFeePerGas, sent.maxPriorityFeePerGas], [quantity(GWEI / 10n + GWEI / 50n), undefined, undefined]);
});

test("planWards: simulates a swap that names no price at the chain's regular price, and the wards at gasPrice when given", async () => {
    const c = client({ tip: GWEI / 20n, bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const plan = await planWards(swap(), { client: c, vanHelsing: VH, gasPrice: GWEI });
    assert.equal(plan.gasPrice, GWEI, "the wards are weighed at the price they are sent at");
    for (const x of c.seen.flat()) {
        if (same(x.to, ROUTER)) assert.deepEqual([x.gasPrice, x.gas], [quantity(GWEI / 20n), quantity(MAX_TX_GAS)]);
        if (isWard(x)) assert.equal(x.gasPrice, quantity(GWEI));
    }

    // a swap that names no sender has nobody to pay its gas: it runs at 0, and so do its wards
    const anyone = client();
    await planWards({ to: ROUTER, data: "0x" }, { client: anyone, vanHelsing: VH, after: "always" });
    assert.ok(anyone.seen.flat().every((x) => x.gasPrice === undefined));
    assert.deepEqual(anyone.balances, []);
});

// A node takes gas limit × price from a call's sender before it runs the call, the limit and not
// the gas the call uses: one in five swap senders on BNB Chain holds too little for a whole
// block's gas at 0.05 gwei, and an EIP-7702 account that spends its own BNB in its batch is left
// short by a prepay larger than its own. The plan pays that gas from what it adds to the
// sender's balance, so the sender keeps what it holds for its calls.
test("planWards: pays the gas of the calls it sends from a balance it adds to their sender's", async () => {
    const bounties = { [`after:${ID1}`]: [WBNB, 10n ** 16n] };
    for (const balance of [10n ** 24n, 1000n]) {
        const c = client({ bounties, balance });
        await planWards({ ...swap(), value: ONE }, { client: c, vanHelsing: VH });
        assert.deepEqual(c.balances, [[SWAPPER, "0x10"]], "read once, on the block the plan builds on");
        const sending = c.options.filter((o) => o.blockStateCalls[0].calls.some((x) => x.from && same(x.from, SWAPPER)));
        assert.ok(sending.length > 1, "the swap alone, then with its wards");
        for (const o of sending) {
            const mine = o.blockStateCalls[0].calls.filter((x) => x.from && same(x.from, SWAPPER));
            const gas = mine.reduce((sum, x) => sum + BigInt(x.gas) * BigInt(x.gasPrice), 0n);
            assert.equal(BigInt(o.blockStateCalls[0].stateOverrides[SWAPPER].balance), balance + gas);
        }
        assert.ok(c.options.filter((o) => !sending.includes(o)).every((o) => o.blockStateCalls[0].stateOverrides === undefined), "the registry's reads send nothing to pay for");
    }

    // the balance the caller's overrides give the sender is what it holds, whatever the case
    const key = SWAPPER.toLowerCase();
    const given = client({ balance: 0n });
    await planWards(swap(), { client: given, vanHelsing: VH, overrides: { [key]: { balance: quantity(ONE), code: "0x" } } });
    const first = given.options[0].blockStateCalls[0].stateOverrides;
    assert.deepEqual(Object.keys(first), [key], "one entry for the sender");
    assert.equal(first[key].code, "0x");
    assert.equal(BigInt(first[key].balance), ONE + MAX_TX_GAS * (GWEI / 20n));
    assert.deepEqual(given.balances, [], "a balance the caller sets is not read");
});

// An RPC receives the swap signed, raw: planWards decodes it, recovers its sender from its
// signature, and keeps its fees.
const SIGNER = privateKeyToAccount(`0x${"11".repeat(32)}`);

test("planWards: takes a signed transaction as it was received, its sender and fees decoded", async () => {
    const router = ROUTER.toLowerCase(); // as signed: viem checks a mixed-case address against its checksum
    const raw = await SIGNER.signTransaction({ chainId: 56, type: "legacy", nonce: 3, to: router, data: "0xdeadbeef", value: 5n, gas: 300_000n, gasPrice: GWEI });
    const c = client({ bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const plan = await planWards(raw, { client: c, vanHelsing: VH });
    assert.equal(plan.payee, SIGNER.address, "the bounties go back to its signer");
    assert.equal(plan.gasPrice, GWEI, "its own gas price");
    const sent = c.seen[0].find((x) => same(x.to, ROUTER));
    assert.deepEqual([sent.from, sent.data, sent.value, sent.gasPrice], [SIGNER.address, "0xdeadbeef", "0x5", quantity(GWEI)]);
    assert.equal(plan.after.length, 1, "its back-run pays for its ward");

    // EIP-1559 ones, an approval and its swap, in the order received
    const sign = (nonce, to, data) => SIGNER.signTransaction({ chainId: 56, nonce, to, data, gas: 300_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 20n });
    const batch = client({ needsApproval: true, bounties: { [`after:${ID1}`]: [WBNB, 10n ** 16n] } });
    const both = await planWards([await sign(3, TA, approve().data), await sign(4, router, "0xdeadbeef")], { client: batch, vanHelsing: VH });
    assert.equal(both.reverted, false, "the approval runs before the swap");
    assert.equal(both.gasPrice, GWEI / 20n, "the next block's base fee, 0, plus its tip");

    // one signed for another chain is refused
    const elsewhere = await SIGNER.signTransaction({ chainId: 1, nonce: 0, to: router, data: "0x", gas: 21_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI });
    await assert.rejects(planWards(elsewhere, { client: client(), vanHelsing: VH }), /planWards: a transaction signed for chain 1, not 56/);
});
