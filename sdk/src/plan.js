import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, parseTransaction, recoverTransactionAddress } from "viem";
import { simulateCalls, nextBlock, blockParam } from "./simulate.js";
import { identifyPoolIds } from "./identify.js";
import { wardCall, readBounty, shareOf } from "./ward.js";
import { vanHelsingFor } from "./deployments.js";
import { CHAINS, feedCalls, readPrices, nativeWorth } from "./value.js";
import { resolveClient } from "./clients.js";
import { gasPriceOf } from "./gas.js";

const ZERO = "0x0000000000000000000000000000000000000000";
// Sends the simulated wards when the swap names no sender of its own.
const SIM_SENDER = "0x000000000000000000000000000000000000dEaD";
// The gas a call the plan sends runs within: 2^24, the most one transaction may use on Ethereum
// (EIP-7825), and more than any swap replayed on BNB Chain used, or its own limit when higher. A
// swap's own limit was estimated for the state it was to meet: planned on another, a block
// earlier, it can need more, and checking that is its sender's job, not the plan's.
const MAX_TX_GAS = 16_777_216n;
const BEFORE = ["affordable", "profitable", "always", "never"];
const AFTER = ["affordable", "profitable", "always", "never"];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// eth_simulateV1 logs a native transfer as a Transfer from this address (traceTransfers)
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const REGISTRY_ABI = parseAbi([
    "function REGISTRY() view returns (address)",
    "function entryOf(bytes32 id) view returns (uint8 kind, address token0, address token1, uint32 fee, uint64 tax, bool ok)",
    "function poolsFor(address a, address b) view returns (bytes32[])",
]);
const REGISTRY_CALL = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "REGISTRY" });

// Plan VanHelsing's protection of one unsigned swap, every pool it touches, with a ward on
// each side of it:
//   before  a ward just before the swap. It is insurance: it captures whatever a front-run, or
//           any standing gap, left in the pool, so the swap trades at the fair price, and it
//           costs a no-op's gas (about 55k to 60k per pool) when there is nothing to capture.
//   after   a ward just after the swap, taking the back-run the swap itself opens.
// Submit [...before, swap, ...after] as one atomic bundle (see the README).
//
// A swap that needs another call first, such as the approval of the token it pays or the wrap
// of the native token, cannot run before that call lands: pass the calls you send, in order,
// [approveTx, swapTx], and submit [...before, ...calls, ...after]. One sender sends them all.
// Each can be a signed transaction as it was received, raw: it is decoded, and its sender
// recovered from its signature (decodeSigned).
//
// The swap is simulated alone to find its pools and what it moves, then again with its wards
// around it, so each ward's bounty is read off its Captured event and weighed against its own
// gas. The wards before are weighed first; the wards after are weighed on the bundle that is
// sent, behind the wards before that are kept, since a gap one of them would have closed is
// still there for the swap and the wards after it to meet. A ward on a pool VanHelsing's
// registry does not list, or lists with no other pool of its pair to anchor it, captures
// nothing, so it is left out whatever the policy, and the plan says why. Options:
//   client      a viem client whose RPC serves eth_simulateV1, or
//   chain       "bsc" or "ethereum", or chainId 56 or 1, for that chain's default client
//               (clients.js): one of them is required.
//   before      "affordable" (default) | "profitable" | "always" | "never": the wards before.
//   after       "affordable" (default) | "profitable" | "always" | "never": the wards after.
//               "profitable" keeps a ward only when the payee's share of its bounty, less
//               the ward's gas, is worth more than minProfit (default 0, in native wei).
//               "affordable" keeps the wards that are profitable, and the rest while, with the
//               rest on the other leg, their gas costs at most maxPremium (default 0.005, so
//               0.5%) of what the swap is worth (worthOf): before the swap they insure it, after
//               it they capture a back-run the market may open by the time it lands. The wards
//               before come first. A swap it cannot value keeps none of them.
//               A ward that captures nothing and would burn more than maxWardGas (default 500,000)
//               is dropped whatever the policy.
//   payee       who receives the bounties, less VanHelsing's 10%: by default the swap's
//               sender, so they reach the swapper whether the wards are sent as their own
//               transactions or batched through a contract such as Multicall3.
//   gasPrice    wei per gas the wards are sent at, simulated at and weighed against. By default
//               the swap's own, since the wards go out with it (gas.js): its gasPrice, or the next
//               block's base fee plus its tip, at most its maxFeePerGas, with the node's suggested
//               tip, the chain's regular one, for a tip it leaves out. Of a batch, the last call's.
//               The swap runs at its own price whatever this says. A plan simulates every call it
//               sends at its price, as the chain charges it, within MAX_TX_GAS: a contract can read
//               that price, and a simulation at 0 is not the chain the swap is sent to. The gas is
//               paid from what the plan adds to the sender's balance (funded). A swap that names
//               no sender has nobody to pay: it runs at 0.
//   value       async (token, amount) => native wei, or null for no price, for tokens the SDK
//               cannot price (it knows each chain's hub tokens, see value.js).
//   block       the block every simulation builds on, so the pools and the plan see one state:
//               by default the current block number. Each simulates the block after it, stamped
//               as the chain stamps its next block (simulate.js).
//
// Every ward is restored against the most liquid other pool VanHelsing's registry lists for
// its pair: there is no anchor to choose.
//
// The VanHelsing address is resolved from the client's chain (see deployments.js); pass
// { vanHelsing } to override (testnets, a fresh deployment).
//
// Returns { pools, before, after, bounties, payee, vanHelsing, reverted, gasPrice, swapWorthWei }:
// before and after are the wards, as calls { to, data } to VanHelsing with the pool's id and kind
// beside them: batched with the swap, signed into transactions for a bundle, or run as steps of a
// route. bounties says, per simulated ward, what it captured, against which anchor, what that is worth
// against its gas, and why it was kept or not, and swapWorthWei is what the swap was valued at, in
// native wei, or null. The bounties are estimates at the latest block: VanHelsing re-sizes every
// ward when it runs, so if the pools moved in the meantime it captures less, never more than is
// there. A ward before that captures a gap in the swap's favor is kept, and pays that gap to the
// payee: only when the swap then reverts, its quote counting on the gap, is it left out, and
// beforeDropped says so.
export async function planWards(tx, opts = {}) {
    const given = Array.isArray(tx) ? tx : [tx];
    if (given.length === 0) throw new Error("planWards: pass the swap, or the calls that make it, in order");
    const {
        vanHelsing, overrides, before = "affordable", after = "affordable",
        minProfit = 0n, maxPremium = 0.005, maxWardGas = 500_000n, value,
    } = opts;
    if ("anchors" in opts || "maxAnchors" in opts) {
        throw new Error("planWards: the anchors option is gone, the registry's deepest pool always anchors");
    }
    if ("minProfitRatio" in opts) {
        throw new Error("planWards: minProfitRatio is gone: pass minProfit, the least a ward must net after its gas, in native wei");
    }
    if ("to" in opts) {
        throw new Error("planWards: to is now payee, who receives the bounties");
    }
    for (const [name, choice, allowed] of [["before", before, BEFORE], ["after", after, AFTER]]) {
        if (!allowed.includes(choice)) throw new Error(`planWards: ${name} must be one of ${allowed.join(", ")}, got ${choice}`);
    }
    if (!(Number.isFinite(maxPremium) && maxPremium >= 0)) {
        throw new Error(`planWards: maxPremium must be a share of the swap such as 0.005, got ${maxPremium}`);
    }

    const client = await resolveClient(opts);
    const chainId = client?.chain?.id ?? (await client.getChainId());
    const vh = vanHelsing ?? vanHelsingFor(chainId);
    if (!vh) throw new Error(`planWards: no known VanHelsing deployment for chain ${chainId}; pass { vanHelsing } to override`);
    const calls = await Promise.all(given.map((c) => (typeof c === "string" ? decodeSigned(c, chainId) : c)));
    const sender = calls.find((c) => c.from)?.from;
    const payee = opts.payee ?? sender ?? ZERO;

    // One block for every simulation below: BNB Chain makes a block every 0.45s, and wards
    // weighed on different states could not be compared.
    const { block, time } = await nextBlock(client, opts.block ?? "latest", chainId);
    // What the swap pays per gas, and what its sender holds to prepay it.
    const [swapPrice, held] = await Promise.all([
        gasPriceOf(calls.at(-1), { client, block }),
        sender ? heldBy(sender, overrides, { client, block }) : null,
    ]);
    const gasPrice = opts.gasPrice != null ? BigInt(opts.gasPrice) : swapPrice;
    const asSent = sender ? calls.map((c) => priced(c, swapPrice)) : calls;
    // The address of VanHelsing's registry, read first so a swap that burns all its gas cannot
    // starve the read, and the swap alone, with its native transfers logged so what it moves
    // can be valued.
    const first = [{ to: vh, data: REGISTRY_CALL }, ...asSent];
    const [registry, ...alone] = await simulateCalls(first, { client, overrides: funded(overrides, sender, held, first), block, time, traceTransfers: true });
    const logs = alone.flatMap((r) => r.logs);
    const reverted = alone.some((r) => r.reverted);
    const pools = identifyPoolIds(logs);

    const plan = { pools, before: [], after: [], bounties: [], payee, vanHelsing: vh, reverted, gasPrice, swapWorthWei: null };
    if (reverted || pools.length === 0 || (before === "never" && after === "never")) return plan;

    const chain = CHAINS[Number(chainId)];
    const base = { calls: asSent, sender, held, gasPrice, pools, vh, payee, chain, client, overrides, block, time, wardAfter: after !== "never" };
    const wardBefore = pools.map(() => before !== "never");
    // The bundle, and alongside it which pools VanHelsing can anchor.
    let [sim, anchors] = await Promise.all([
        evaluate({ ...base, wardBefore }),
        anchorsOf(pools, registryOf(registry), { client, overrides, block, time }),
    ]);
    if (sim.swapReverted && !wardBefore.some(Boolean)) {
        plan.reverted = true;
        return plan;
    }

    const known = nativeWorth(chain, sim.prices);
    // value sees every token checksummed, and may answer a bigint, a number or null
    const worth = async (token, amount) => {
        if (value) {
            const v = await value(getAddress(token), amount);
            if (v === null) return null;
            if (v !== undefined) return typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);
        }
        return known(token, amount);
    };
    plan.swapWorthWei = await worthOf(calls, sender, logs, worth);

    const ctx = { vh, gasPrice, worth, minProfit: BigInt(minProfit), maxWardGas: BigInt(maxWardGas) };
    const weighed = [];
    const insurance = [];
    const paying = new Set();
    for (let i = 0; i < pools.length; i++) {
        if (!sim.before[i]) continue;
        const { entry, pays, blocked, unanchored } = await weigh("before", pools[i], sim.before[i], anchors?.[i], ctx);
        plan.bounties.push(entry);
        weighed.push([i, entry]);
        if (blocked || unanchored) continue;
        if (before === "always") {
            entry.kept = true;
            entry.note = "insurance: sent whether or not there is a gap to capture";
        } else if (pays) {
            entry.kept = true;
        } else if (before === "affordable") {
            insurance.push(entry);
        }
        if (pays) paying.add(entry);
    }
    afford(insurance, plan.swapWorthWei, maxPremium, { leg: "before" });
    const kept = () => pools.map((_, i) => weighed.some(([j, entry]) => j === i && entry.kept));

    // The bundle that is sent: the swap behind only the wards before that are kept, which the
    // wards after are weighed on. A ward on a pool VanHelsing cannot anchor does nothing, so
    // leaving it out changes nothing.
    const anchored = (i) => !anchors || anchors[i] === "anchored";
    const differs = (a, b) => pools.some((_, i) => a[i] !== b[i] && anchored(i));
    let sent = kept();
    if ((after !== "never" || sim.swapReverted) && differs(sent, wardBefore)) sim = await evaluate({ ...base, wardBefore: sent });
    if (sim.swapReverted) {
        // A ward before that captures a gap in the swap's favor pays it to the payee and gives
        // the swap the fair price. Only when the swap then reverts, its quote counting on that gap,
        // is the ward left out, so the swap still goes: a ward that captures nothing cannot fail
        // the swap, and can still undo a front-run. Should the swap revert even so, every ward
        // before is left out.
        const passes = [
            [(entry) => entry.amount > 0n, "left out: the swap reverts after it, its quote counting on the gap it captures"],
            [() => true, "left out: the swap reverts after the wards before it"],
        ];
        for (const [leaveOut, note] of passes) {
            const previous = sent;
            for (const [, entry] of weighed) {
                if (!entry.kept || !leaveOut(entry)) continue;
                entry.kept = false;
                entry.note = note;
            }
            sent = kept();
            if (!differs(sent, previous)) continue;
            sim = await evaluate({ ...base, wardBefore: sent });
            if (!sim.swapReverted) break;
        }
        if (sim.swapReverted) {
            plan.reverted = true;
            return plan;
        }
        plan.beforeDropped = "the swap reverts after the wards before it: its quote counts on the gap they capture, so they are left out and the swap goes without them";
    }
    // what the wards before that may capture nothing cost, which the wards after share maxPremium with
    let spent = 0n;
    for (const [i, entry] of weighed) {
        if (!entry.kept) continue;
        if (!paying.has(entry)) spent += entry.costWei;
        plan.before.push(wardCall(pools[i], { vanHelsing: vh, payee }));
    }
    if (after === "never") return plan;
    const afterWeighed = [];
    const options = [];
    for (let i = 0; i < pools.length; i++) {
        const { entry, pays, blocked, unanchored } = await weigh("after", pools[i], sim.after[i], anchors?.[i], ctx);
        plan.bounties.push(entry);
        afterWeighed.push([i, entry]);
        if (blocked || unanchored) continue;
        if (after === "always") {
            entry.kept = true;
            entry.note = "sent whether or not it pays";
        } else if (pays) {
            entry.kept = true;
        } else if (after === "affordable") {
            options.push(entry);
        }
    }
    afford(options, plan.swapWorthWei, maxPremium, { leg: "after", spent });
    for (const [i, entry] of afterWeighed) {
        if (entry.kept) plan.after.push(wardCall(pools[i], { vanHelsing: vh, payee }));
    }
    return plan;
}

// One simulation of [...before, ...calls, ...after] and, where the chain has them, its dollar
// price feeds read in the same block. `wardBefore` says, per pool, whether a ward runs before
// the swap; its result is null where none does. The wards are sent at `gasPrice` by the calls'
// sender, or at 0 when they name none.
async function evaluate({ calls, sender, held, gasPrice, pools, vh, payee, chain, client, overrides, block, time, wardBefore, wardAfter }) {
    const ward = (p) => {
        const call = { ...wardCall(p, { vanHelsing: vh, payee }), from: sender ?? SIM_SENDER };
        return sender ? priced(call, gasPrice) : call;
    };
    const list = [
        ...pools.filter((_, i) => wardBefore[i]).map(ward),
        ...calls,
        ...(wardAfter ? pools.map(ward) : []),
        ...feedCalls(chain),
    ];
    const r = await simulateCalls(list, { client, overrides: funded(overrides, sender, held, list), block, time });
    const nb = wardBefore.filter(Boolean).length;
    const nc = calls.length;
    const na = wardAfter ? pools.length : 0;
    let k = 0;
    return {
        before: pools.map((_, i) => (wardBefore[i] ? r[k++] : null)),
        swapReverted: r.slice(nb, nb + nc).some((x) => x.reverted),
        after: r.slice(nb + nc, nb + nc + na),
        prices: readPrices(chain, r.slice(nb + nc + na)),
    };
}

// A signed transaction as it was received, raw: what to simulate of it, its sender recovered from
// its signature and its fees with it. One signed for another chain than the plan's is refused.
async function decodeSigned(raw, chainId) {
    const tx = parseTransaction(raw);
    if (tx.chainId !== undefined && Number(tx.chainId) !== Number(chainId)) {
        throw new Error(`planWards: a transaction signed for chain ${tx.chainId}, not ${chainId}`);
    }
    return { ...tx, from: await recoverTransactionAddress({ serializedTransaction: raw }) };
}

// A call as the chain charges it: at `price` per gas, within MAX_TX_GAS or its own limit when
// higher. The price is the effective one, so it replaces the call's EIP-1559 fees.
function priced(call, price) {
    const gas = call.gas != null && BigInt(call.gas) > MAX_TX_GAS ? call.gas : MAX_TX_GAS;
    return { ...call, gas, gasPrice: price, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined };
}

// What `sender` holds on the block the plan builds on: the balance the caller's overrides give
// it, or its own.
async function heldBy(sender, overrides, { client, block }) {
    const given = overrides?.[keyOf(overrides, sender)]?.balance;
    if (given != null) return BigInt(given);
    return BigInt(await client.request({ method: "eth_getBalance", params: [sender, blockParam(block)] }));
}

// The state overrides one simulation of `list` runs with: the caller's, and the sender's balance
// with the gas of every call it sends there added. A node takes gas limit × price from a call's
// sender before it runs the call, the limit and not the gas the call uses: one in five swap
// senders on BNB Chain holds too little for a whole block's gas at 0.05 gwei, and an EIP-7702
// account that spends its own BNB in its batch would be left short by a prepay larger than its
// own. Paid from what is added, the gas leaves the sender what it holds for its calls.
function funded(overrides, sender, held, list) {
    if (!sender) return overrides;
    const mine = list.filter((c) => c.from && c.from.toLowerCase() === sender.toLowerCase());
    const gas = mine.reduce((sum, c) => sum + BigInt(c.gas ?? 0) * BigInt(c.gasPrice ?? 0), 0n);
    if (gas === 0n) return overrides;
    const key = keyOf(overrides, sender);
    return { ...overrides, [key]: { ...overrides?.[key], balance: `0x${(held + gas).toString(16)}` } };
}

// The key the overrides give an address, in whatever case, or the address itself.
function keyOf(overrides, address) {
    return Object.keys(overrides ?? {}).find((k) => k.toLowerCase() === address.toLowerCase()) ?? address;
}

// The registry address VanHelsing's REGISTRY() answered, or null when it did not.
function registryOf(res) {
    if (!res || res.reverted || !res.returnData || res.returnData === "0x") return null;
    try {
        return decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "REGISTRY", data: res.returnData });
    } catch {
        return null;
    }
}

// Whether a ward can capture on each pool: "anchored" when VanHelsing's registry lists the pool
// with another pool of its pair, the anchor; "unlisted" or "alone" when it cannot. null when the
// registry cannot be read: then no pool is left out.
async function anchorsOf(pools, registry, opts) {
    if (!registry) return null;
    try {
        return await readAnchors(pools, registry, opts);
    } catch {
        return null; // an address that answers like no registry: leave no pool out
    }
}

async function readAnchors(pools, registry, { client, overrides, block, time }) {
    const call = (functionName, args) => ({ to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName, args }) });
    const entries = await simulateCalls(pools.map((p) => call("entryOf", [p.id])), { client, overrides, block, time });
    if (entries.some((e) => e.reverted || e.returnData === "0x")) return null;
    const pairs = entries.map((e) => {
        const [, token0, token1, , , ok] = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "entryOf", data: e.returnData });
        return ok ? `${token0},${token1}` : null;
    });
    const keys = [...new Set(pairs.filter(Boolean))];
    const lists = keys.length ? await simulateCalls(keys.map((k) => call("poolsFor", k.split(","))), { client, overrides, block, time }) : [];
    if (lists.some((l) => l.reverted || l.returnData === "0x")) return null;
    const listed = Object.fromEntries(keys.map((k, i) => [
        k, decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "poolsFor", data: lists[i].returnData }).map((id) => id.toLowerCase()),
    ]));
    return pools.map((p, i) => {
        if (!pairs[i]) return "unlisted";
        return listed[pairs[i]].some((id) => id !== p.id.toLowerCase()) ? "anchored" : "alone";
    });
}

// What the swap is worth in native wei: the most its sender pays or receives of one token,
// summed over every leg of the route and every call of a batch, net of refunds, the native token
// included. When the swap names no sender, or nothing the sender pays or receives can be priced,
// it is the largest amount of one token the swap moves. null when nothing it moves can be
// priced. Each token is priced once, and a token `worth` throws on counts as one it cannot price.
async function worthOf(calls, from, logs, worth) {
    const sender = from ? from.toLowerCase() : null;
    const net = new Map(); // token -> what the sender paid, less what it received
    const most = new Map(); // token -> the largest amount of it one transfer moved
    let nativeTraced = false;
    for (const log of logs) {
        if ((log.topics?.[0] || "").toLowerCase() !== TRANSFER || log.topics.length !== 3) continue;
        if (!log.data || log.data.length < 66) continue;
        const token = (log.address || "").toLowerCase();
        const amount = BigInt(log.data.slice(0, 66));
        if (amount > (most.get(token) ?? 0n)) most.set(token, amount);
        const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
        const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
        if (from === sender) {
            net.set(token, (net.get(token) ?? 0n) + amount);
            if (token === NATIVE) nativeTraced = true;
        }
        if (to === sender) net.set(token, (net.get(token) ?? 0n) - amount);
    }
    const sent = calls.reduce((sum, c) => sum + (c.value ? BigInt(c.value) : 0n), 0n);
    if (sent > 0n) {
        // an RPC that does not trace native transfers still shows the value the swap sends
        if (sender && !nativeTraced) net.set(NATIVE, (net.get(NATIVE) ?? 0n) + sent);
        if (sent > (most.get(NATIVE) ?? 0n)) most.set(NATIVE, sent);
    }
    const unpriced = new Set();
    const priced = async (amounts) => {
        let best = null;
        for (const [token, signed] of amounts) {
            const amount = signed < 0n ? -signed : signed;
            if (amount === 0n || unpriced.has(token)) continue;
            let w;
            try {
                w = token === NATIVE ? amount : await worth(token, amount);
            } catch {
                w = null;
            }
            if (w === null || w === undefined) unpriced.add(token);
            else if (best === null || w > best) best = w;
        }
        return best;
    };
    return (await priced(net)) ?? (await priced(most));
}

// What one simulated ward captured and what the payee's share is worth against the ward's own
// gas. `pays` when the share, less the gas, is worth more than minProfit; `unanchored` when
// VanHelsing cannot anchor its pool, so it captures nothing; `blocked` when it is never sent:
// its call reverted, or it would burn its gas and capture nothing. The entry's note says which.
async function weigh(leg, pool, res, anchor, { vh, gasPrice, worth, minProfit, maxWardGas }) {
    const entry = {
        leg, id: pool.id, kind: pool.kind, anchor: null,
        token: null, amount: 0n, share: 0n, worthWei: null,
        gasUsed: res.gasUsed, costWei: res.gasUsed * gasPrice,
        kept: false, note: "",
    };
    const blocked = (note) => ({ entry: Object.assign(entry, { note }), pays: false, blocked: true });
    if (res.reverted) return blocked("the ward call reverted: is VanHelsing deployed at this address?");
    const bounty = readBounty(res.logs, vh);
    if (!bounty && res.gasUsed > maxWardGas) {
        // in a call that runs out of gas, the gas it was given is burned for nothing
        return blocked(`it would burn ${res.gasUsed} gas and capture nothing`);
    }
    if (anchor === "unlisted" || anchor === "alone") {
        entry.note = anchor === "unlisted"
            ? "VanHelsing does not list this pool, so its ward captures nothing"
            : "VanHelsing lists no other pool of its pair to anchor it, so its ward captures nothing";
        return { entry, pays: false, blocked: false, unanchored: true };
    }
    if (!bounty) {
        entry.note = "nothing to capture";
        return { entry, pays: false, blocked: false };
    }
    entry.anchor = bounty.anchor;
    entry.token = bounty.token;
    entry.amount = bounty.amount;
    entry.share = shareOf(bounty.amount);
    entry.worthWei = await worth(bounty.token, entry.share);
    if (entry.worthWei === null) {
        entry.note = `no price for ${bounty.token}: pass value to weigh it`;
        return { entry, pays: false, blocked: false };
    }
    const net = entry.worthWei - entry.costWei;
    const pays = net > minProfit;
    if (pays) entry.note = `worth ${times(entry.worthWei, entry.costWei)} its gas`;
    else entry.note = net <= 0n && minProfit >= 0n ? "worth less than its gas" : "nets less than minProfit after its gas";
    return { entry, pays, blocked: false };
}

// The wards of one leg that may capture nothing, kept together while their gas, with what such
// wards before already cost (`spent`), is at most maxPremium of what the swap is worth. Before
// the swap they are its insurance; after it, a back-run the market may open by the time it lands.
function afford(wards, swapWorthWei, maxPremium, { leg, spent = 0n }) {
    if (wards.length === 0) return;
    if (swapWorthWei === null) {
        const note = leg === "before"
            ? 'insurance left out: no price for the swap, which moves no token the SDK knows; pass value, or before: "always"'
            : 'left out: no price for the swap, which moves no token the SDK knows; pass value, or after: "always"';
        for (const w of wards) w.note = note;
        return;
    }
    const cost = wards.reduce((sum, w) => sum + w.costWei, spent);
    const share = percent(cost, swapWorthWei);
    const affordable = cost * 1_000_000n <= swapWorthWei * BigInt(Math.round(maxPremium * 1_000_000));
    const withBefore = spent > 0n ? " with the insurance before it" : "";
    for (const w of wards) {
        w.kept = affordable;
        if (leg === "before") {
            w.note = affordable ? `insurance: ${share} of the swap` : `insurance would cost ${share} of the swap, more than maxPremium allows`;
        } else {
            w.note = affordable
                ? `affordable: ${share} of the swap${withBefore ? `,${withBefore}` : ""}`
                : `would cost ${share} of the swap${withBefore}, more than maxPremium allows`;
        }
    }
}

// num / den as a percentage with three decimals: "0.012%", or "under 0.001%".
function percent(num, den) {
    if (den <= 0n) return "an unknown share";
    const milli = (num * 100_000n) / den;
    if (milli === 0n && num > 0n) return "under 0.001%";
    return `${milli / 1000n}.${String(milli % 1000n).padStart(3, "0")}%`;
}

function times(worth, cost) {
    if (cost === 0n) return "more than";
    const tenths = (worth * 10n) / cost;
    return `${tenths / 10n}.${tenths % 10n}x`;
}
