import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, simulateCalls } from "../src/simulate.js";
import { defaultClient } from "../src/clients.js";

const V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const POOL = "0x6beb20557c2f9ef1327ef615c140cbf38440f630";

// A client whose head is block `head`, made at `timestamp`, on chain `chainId`, and whose
// eth_simulateV1 answers `response`. `asked` records the methods it is asked.
function mockClient(response, { throwUnsupported = false, head = 100n, timestamp = 1_000n, chainId = 56 } = {}) {
    const asked = [];
    return {
        asked,
        async request({ method, params }) {
            asked.push(method);
            if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
            if (method === "eth_getBlockByNumber") {
                const number = params[0] === "latest" ? head : BigInt(params[0]);
                return { number: `0x${number.toString(16)}`, timestamp: `0x${timestamp.toString(16)}` };
            }
            if (throwUnsupported) throw new Error("the method eth_simulateV1 does not exist/is not available");
            assert.equal(method, "eth_simulateV1");
            mockClient.lastParams = params;
            return response;
        },
    };
}
const OK = [{ calls: [{ status: "0x1", logs: [] }] }];

test("returns logs from the simulated call", async () => {
    const client = mockClient([{ calls: [{ status: "0x1", logs: [{ address: POOL, topics: [V2] }] }] }]);
    const out = await simulate({ to: "0xrouter", data: "0xabc" }, { client });
    assert.equal(out.reverted, false);
    assert.deepEqual(out.logs, [{ address: POOL, topics: [V2] }]);
});

test("reverted status still returns logs so far", async () => {
    const client = mockClient([{ calls: [{ status: "0x0", logs: [{ address: POOL, topics: [V2] }] }] }]);
    const out = await simulate({ to: "0xrouter", data: "0xabc" }, { client });
    assert.equal(out.reverted, true);
    assert.equal(out.logs.length, 1);
});

test("unsupported RPC surfaces a clear error", async () => {
    const client = mockClient(null, { throwUnsupported: true });
    await assert.rejects(() => simulate({ to: "0xr", data: "0x" }, { client }), /eth_simulateV1/);
});

test("simulate takes a chain slug for that chain's default client, and needs a client or a chain", async () => {
    const bsc = defaultClient("bsc");
    const request = bsc.request;
    bsc.request = async ({ method }) => {
        if (method === "eth_getBlockByNumber") return { number: "0x64", timestamp: "0x3e8" };
        assert.equal(method, "eth_simulateV1");
        return [{ calls: [{ status: "0x1", logs: [{ address: POOL, topics: [V2] }] }] }];
    };
    try {
        const out = await simulate({ to: "0xrouter", data: "0xabc" }, { chain: "bsc" });
        assert.deepEqual(out.logs, [{ address: POOL, topics: [V2] }]);
        const byId = await simulate({ to: "0xrouter", data: "0xabc" }, { chainId: 56 });
        assert.deepEqual(byId.logs, [{ address: POOL, topics: [V2] }]);
    } finally {
        bsc.request = request;
    }
    await assert.rejects(() => simulate({ to: "0xr", data: "0x" }, {}), /simulate: pass a client, a chain \(bsc, ethereum or robinhood\) or a chainId \(56, 1 or 4663\)/);
    await assert.rejects(() => simulate({ to: "0xr", data: "0x" }, { chain: "solana" }), /no default client for chain "solana"/);
});

// Left to itself, a node puts the simulated block 12 s after its parent. BNB Chain makes a block
// every 0.45 s: there, a swap whose deadline or quote runs out within those 12 s would revert.
test("simulates the block after the one it builds on as the chain makes it: a second later on BNB Chain, 12 on Ethereum", async () => {
    const bsc = mockClient(OK, { head: 100n, timestamp: 1_000n, chainId: 56 });
    await simulate({ to: "0xrouter", data: "0xabc" }, { client: bsc });
    const [opts, block] = mockClient.lastParams;
    assert.equal(block, "0x64", "pinned to the head it read, so the head cannot move under it");
    assert.deepEqual(opts.blockStateCalls[0].blockOverrides, { time: "0x3e9" });

    const ethereum = mockClient(OK, { timestamp: 1_000n, chainId: 1 });
    await simulate({ to: "0xrouter", data: "0xabc" }, { client: ethereum });
    assert.deepEqual(mockClient.lastParams[0].blockStateCalls[0].blockOverrides, { time: "0x3f4" });

    const pinned = mockClient(OK, { timestamp: 2_000n });
    await simulate({ to: "0xrouter", data: "0xabc" }, { client: pinned, block: 7n });
    assert.equal(mockClient.lastParams[1], "0x7");
    assert.deepEqual(mockClient.lastParams[0].blockStateCalls[0].blockOverrides, { time: "0x7d1" });

    const timed = mockClient(OK);
    await simulateCalls([{ to: "0xrouter", data: "0xabc" }], { client: timed, block: 7n, time: 1_234n });
    assert.deepEqual(timed.asked, ["eth_simulateV1"], "a block and a time given, there is no header to read");
    assert.deepEqual(mockClient.lastParams[0].blockStateCalls[0].blockOverrides, { time: "0x4d2" });
});

test("takes a transaction as the RPC returns it, with its input as data, and a 7702 transaction with its authorizations", async () => {
    const SENDER = "0x00000000000000000000000000000000000A11cE";
    const IMPL = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
    const client = mockClient(OK);
    await simulateCalls([
        { from: SENDER, to: SENDER, input: "0x34fcd5be", value: "0x0", authorizationList: [{ address: IMPL, chainId: "0x38", nonce: "0x7", yParity: "0x1", r: "0xab", s: "0x5" }] },
        // as viem signs one: numbers, and r and s padded to 32 bytes
        { from: SENDER, to: SENDER, data: "0x34fcd5be", value: 10, authorizationList: [{ address: IMPL, chainId: 56, nonce: 7, yParity: 1, r: `0x${"0".repeat(62)}ab`, s: `0x${"0".repeat(63)}5` }] },
        // an older signature, with v
        { from: SENDER, to: SENDER, data: "0x34fcd5be", authorizationList: [{ contractAddress: IMPL, chainId: 56, nonce: 7, v: 28n, r: "0xab", s: "0x5" }] },
        // an RPC that returns an empty data beside the input
        { from: SENDER, to: SENDER, data: "0x", input: "0x34fcd5be" },
    ], { client });
    const authorization = { address: IMPL, chainId: "0x38", nonce: "0x7", yParity: "0x1", r: "0xab", s: "0x5" };
    assert.deepEqual(mockClient.lastParams[0].blockStateCalls[0].calls, [
        { from: SENDER, to: SENDER, data: "0x34fcd5be", value: "0x0", authorizationList: [authorization] },
        { from: SENDER, to: SENDER, data: "0x34fcd5be", value: "0xa", authorizationList: [authorization] },
        { from: SENDER, to: SENDER, data: "0x34fcd5be", authorizationList: [authorization] },
        { from: SENDER, to: SENDER, data: "0x34fcd5be" },
    ]);
});

test("passes a call's own gas limit and price, an EIP-1559 call's fees in place of its gasPrice", async () => {
    const client = mockClient(OK);
    await simulateCalls([
        { to: "0xrouter", data: "0xabc", gas: 300_000n, gasPrice: 50_000_000n },
        // a mined EIP-1559 transaction as the RPC returns it: its effective gasPrice beside its fees
        { to: "0xrouter", input: "0xabc", gas: "0x493e0", gasPrice: "0x2faf080", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x2faf080" },
        { to: "0xrouter", data: "0xabc" },
    ], { client });
    assert.deepEqual(mockClient.lastParams[0].blockStateCalls[0].calls, [
        { to: "0xrouter", data: "0xabc", gas: "0x493e0", gasPrice: "0x2faf080" },
        { to: "0xrouter", data: "0xabc", gas: "0x493e0", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x2faf080" },
        { to: "0xrouter", data: "0xabc" },
    ]);
});
