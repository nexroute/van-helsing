import { resolveClient, secondsToNextBlock } from "./clients.js";

// Simulate unsigned calls statelessly with eth_simulateV1, in one block, in order: each call
// sees the state the previous ones left, on `client`, or on the default client of `chain` or
// `chainId` ("bsc" or 56, "ethereum" or 1, "robinhood" or 4663, see clients.js). A call is
// { from, to, data, value } as viem takes it, or a transaction as the RPC returns it, its data
// in `input`, with the authorizationList of a 7702 transaction. A call that names its gas limit
// and price runs with them, its sender prepaying limit × price as on chain; one that names no
// price runs at 0 (planWards prices every call it sends, see plan.js). Optional `overrides`
// (eth_simulateV1 stateOverrides) let a not-yet-funded/approved swap still execute. `block` is
// the block to build on, a number or a tag ("latest" by default), and `time` the simulated
// block's timestamp, in seconds: by default the chain's next block (see nextBlock). `traceTransfers` also logs every native transfer, as a
// Transfer from 0xEeee...EEeE. A reverting call yields whatever logs the node returns for it,
// none on Geth and BNB Chain's node.
export async function simulateCalls(calls, { client, chain, chainId, overrides, block = "latest", time, traceTransfers = false } = {}) {
    client = await resolveClient({ client, chain, chainId }, "simulate");
    if (time === undefined) ({ block, time } = await nextBlock(client, block));
    const state = { blockOverrides: { time: quantity(time) }, calls: calls.map(callOf) };
    if (overrides) state.stateOverrides = overrides;
    const params = [{ blockStateCalls: [state], validation: false, traceTransfers }, blockParam(block)];

    let result;
    try {
        result = await client.request({ method: "eth_simulateV1", params });
    } catch (e) {
        const msg = String(e?.message || e);
        if (/not (found|available|supported|exist)|method eth_simulateV1/i.test(msg)) {
            throw new Error(`simulate: this RPC does not support eth_simulateV1 (${msg.slice(0, 120)})`);
        }
        throw e;
    }

    const results = result?.[0]?.calls || [];
    return calls.map((_, i) => {
        const r = results[i] || {};
        return {
            reverted: r.status !== undefined && BigInt(r.status) === 0n,
            logs: r.logs || [],
            gasUsed: r.gasUsed !== undefined ? BigInt(r.gasUsed) : 0n,
            returnData: r.returnData || "0x",
        };
    });
}

// The block to build on, pinned to its number so that "latest" cannot move under the
// simulation, and the timestamp of the block after it as the chain makes it. Left to itself, a
// node stamps the simulated block 12 s after its parent, as on Ethereum: on BNB Chain, which
// makes a block every 0.45 s, a swap whose deadline or quote runs out within those 12 s reverts
// there, and a plan of it finds no pool.
export async function nextBlock(client, block = "latest", chainId) {
    const header = await client.request({ method: "eth_getBlockByNumber", params: [blockParam(block), false] });
    if (!header) throw new Error(`simulate: the RPC has no block ${block}`);
    const id = chainId ?? client.chain?.id ?? (typeof client.getChainId === "function"
        ? await client.getChainId()
        : await client.request({ method: "eth_chainId" }));
    return { block: BigInt(header.number), time: BigInt(header.timestamp) + BigInt(secondsToNextBlock(id)) };
}

// A call as eth_simulateV1 takes it, its numbers as hex quantities. Its data is in `data`, or in
// `input` as the RPC returns a transaction: some RPCs return an empty `data` beside it.
function callOf(c) {
    const call = { to: c.to, data: c.input && (!c.data || c.data === "0x") ? c.input : c.data };
    if (c.from) call.from = c.from;
    if (c.value != null) call.value = quantity(c.value);
    if (c.gas != null) call.gas = quantity(c.gas);
    // A mined EIP-1559 transaction, as the RPC returns it, has its effective gasPrice beside its
    // fees, and a node takes one or the other.
    if (c.maxFeePerGas != null || c.maxPriorityFeePerGas != null) {
        if (c.maxFeePerGas != null) call.maxFeePerGas = quantity(c.maxFeePerGas);
        if (c.maxPriorityFeePerGas != null) call.maxPriorityFeePerGas = quantity(c.maxPriorityFeePerGas);
    } else if (c.gasPrice != null) {
        call.gasPrice = quantity(c.gasPrice);
    }
    if (c.authorizationList) {
        call.authorizationList = c.authorizationList.map((a) => ({
            address: a.address ?? a.contractAddress,
            chainId: quantity(a.chainId),
            nonce: quantity(a.nonce),
            // an older signature carries v, 27 or 28, for its y parity
            yParity: quantity(a.yParity ?? (BigInt(a.v) >= 27n ? BigInt(a.v) - 27n : BigInt(a.v))),
            r: quantity(a.r),
            s: quantity(a.s),
        }));
    }
    return call;
}

// A number, a bigint or a hex string as a JSON-RPC quantity: hex, with no leading zero.
function quantity(n) {
    return `0x${BigInt(n).toString(16)}`;
}

// A block as JSON-RPC takes it: a number in hex, a tag such as "latest" as it is.
export function blockParam(block) {
    return typeof block === "string" ? block : `0x${BigInt(block).toString(16)}`;
}

// Simulate one unsigned swap tx and return its logs (used to identify the pools it
// touches) and whether it reverted.
export async function simulate(tx, { client, chain, chainId, overrides, block, time } = {}) {
    const [r] = await simulateCalls([tx], { client, chain, chainId, overrides, block, time });
    return { logs: r.logs, reverted: r.reverted };
}
