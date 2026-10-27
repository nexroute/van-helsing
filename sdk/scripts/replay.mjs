// Replays real swaps through planWards' first step, the simulation that finds a swap's pools, and
// compares the pools it finds with those the swap really touched, read off its receipt. Each swap
// is planned as it was sent, at its own gas price within its own gas limit, on the block before its
// own, as a wallet planning it just before sending it would. A swap that reverts there is planned
// again with what its sender sent before it in its block, such as its approval, as a wallet that
// batches them would plan them, against the pools they all touched.
//
//   node scripts/replay.mjs <rpc> [blocks=100] [span=40000]
//
// It samples `blocks` BNB Chain blocks spread over the last `span`. The RPC must serve
// eth_simulateV1 on their parents: an archive node, or a node that keeps that much state.
// A router three or more senders use in the sample counts as shared: what wallets and apps send,
// apart from the bots' own contracts.
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { identifyPoolIds } from "../src/identify.js";
import { planWards } from "../src/plan.js";

const [rpc, blocks = "100", span = "40000"] = process.argv.slice(2);
if (!rpc) {
    console.error("usage: node scripts/replay.mjs <rpc> [blocks=100] [span=40000]");
    process.exit(1);
}
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 60_000, retryCount: 3 }) });
const hex = (n) => `0x${n.toString(16)}`;
const ids = (logs) => identifyPoolIds(logs).map((p) => p.id);
// planWards finds the pools on its first simulation and stops there when it is to send no ward;
// it reads no VanHelsing to do so.
const NOBODY = "0x00000000000000000000000000000000DeaDBeef";
const poolsOf = async (calls, block) => {
    const plan = await planWards(calls, { client, vanHelsing: NOBODY, block, before: "never", after: "never" });
    return plan.reverted ? null : plan.pools.map((p) => p.id);
};

// How the pools found compare with the pools the swap touched.
function compare(found, truth) {
    if (found.length === truth.length && found.every((id) => truth.includes(id))) return "exact";
    if (found.length === 0) return "none";
    if (truth.every((id) => found.includes(id))) return "more";
    return found.every((id) => truth.includes(id)) ? "fewer" : "other";
}

async function inParallel(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (next < items.length) await fn(items[next++]);
    }));
}

const head = await client.getBlockNumber();
const step = BigInt(Math.floor(Number(span) / Number(blocks)));
const rows = [];
for (let k = 0n; k < BigInt(blocks); k++) {
    const n = head - 50n - k * step;
    const [block, receipts] = await Promise.all([
        client.request({ method: "eth_getBlockByNumber", params: [hex(n), true] }),
        client.request({ method: "eth_getBlockReceipts", params: [hex(n)] }),
    ]);
    const truths = receipts.map((r) => (r.status === "0x1" ? ids(r.logs) : []));
    const swaps = block.transactions.map((tx, i) => ({ tx, i, truth: truths[i] })).filter((s) => s.truth.length > 0);
    await inParallel(swaps, 8, async ({ tx, i, truth }) => {
        const alone = await poolsOf(tx, n - 1n);
        const row = { to: tx.to, from: tx.from, alone: alone ? compare(alone, truth) : "reverted" };
        const earlier = block.transactions.slice(0, i).filter((t) => t.from === tx.from);
        if (!alone && earlier.length > 0) {
            const batch = await poolsOf([...earlier, tx], n - 1n);
            const touched = [...new Set([...earlier.flatMap((t) => truths[block.transactions.indexOf(t)]), ...truth])];
            row.batch = batch ? compare(batch, touched) : "reverted";
            row.approval = earlier.some((t) => t.input.startsWith("0x095ea7b3"));
        }
        rows.push(row);
    });
    process.stderr.write(`\rblock ${n}: ${rows.length} swaps`);
}
process.stderr.write("\n");

const senders = new Map();
for (const r of rows) senders.set(r.to, (senders.get(r.to) ?? new Set()).add(r.from));
const shared = rows.filter((r) => senders.get(r.to).size >= 3);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const line = (label, f) => console.log(`${label.padEnd(50)}${pct(rows.filter(f).length, rows.length).padStart(8)}${pct(shared.filter(f).length, shared.length).padStart(16)}`);
console.log(`${rows.length} swaps in ${blocks} blocks before ${head}, ${shared.length} through ${new Set(shared.map((r) => r.to)).size} shared routers\n`);
console.log(`${"".padEnd(50)}${"all".padStart(8)}${"shared routers".padStart(16)}`);
line("pools read exactly", (r) => r.alone === "exact");
line("  and one more, such as a token's swap-back", (r) => r.alone === "more");
line("fewer or other pools, or none", (r) => ["fewer", "other", "none"].includes(r.alone));
line("reverted on its own", (r) => r.alone === "reverted");
line("  read exactly after its sender's earlier calls", (r) => r.batch === "exact");
line("    of which one was an approval", (r) => r.batch === "exact" && r.approval);
line("read exactly, alone or so batched", (r) => r.alone === "exact" || r.batch === "exact");
