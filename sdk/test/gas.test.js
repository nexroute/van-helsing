import { test } from "node:test";
import assert from "node:assert/strict";
import { gasPriceOf } from "../src/gas.js";

const GWEI = 10n ** 9n;
const hex = (n) => `0x${n.toString(16)}`;

// A node whose block has a base fee of `base`, the block after it `next`, and whose
// eth_maxPriorityFeePerGas is `tip`. It records what it is asked.
function node({ base = 0n, next = 0n, tip = GWEI / 20n } = {}) {
    const asked = [];
    return {
        asked,
        async request({ method, params }) {
            asked.push({ method, params });
            if (method === "eth_feeHistory") return { oldestBlock: "0x7b", baseFeePerGas: [hex(base), hex(next)], gasUsedRatio: [0.5] };
            if (method === "eth_maxPriorityFeePerGas") return hex(tip);
            throw new Error(`unexpected ${method}`);
        },
    };
}

test("a swap with a gasPrice pays it as it is, and the node is not asked", async () => {
    const client = node();
    assert.equal(await gasPriceOf({ gasPrice: 3n * GWEI }, { client }), 3n * GWEI);
    assert.equal(await gasPriceOf({ gasPrice: "0xb2d05e00" }, { client }), 3n * GWEI);
    assert.deepEqual(client.asked, []);
});

test("an EIP-1559 swap pays the next block's base fee plus its tip, at most its maxFeePerGas", async () => {
    const client = node({ base: 40n * GWEI, next: 45n * GWEI });
    assert.equal(await gasPriceOf({ maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI }, { client, block: 123n }), 47n * GWEI);
    assert.equal(await gasPriceOf({ maxFeePerGas: 46n * GWEI, maxPriorityFeePerGas: 2n * GWEI }, { client, block: 123n }), 46n * GWEI);
    assert.equal(await gasPriceOf({ maxPriorityFeePerGas: 2n * GWEI }, { client, block: 123 }), 47n * GWEI);
    assert.deepEqual(client.asked.map((a) => a.method), ["eth_feeHistory", "eth_feeHistory", "eth_feeHistory"]);
    assert.ok(client.asked.every((a) => JSON.stringify(a.params) === JSON.stringify(["0x1", "0x7b", []])), "the base fee after the block the plan builds on");
});

test("a swap that leaves its fees out pays what a wallet would set: the node's suggested tip, uncapped", async () => {
    const client = node({ next: 45n * GWEI, tip: GWEI / 1000n });
    assert.equal(await gasPriceOf({}, { client }), 45n * GWEI + GWEI / 1000n);
    assert.equal(await gasPriceOf({ maxFeePerGas: 45n * GWEI }, { client }), 45n * GWEI);
    assert.deepEqual(client.asked.find((a) => a.method === "eth_feeHistory").params, ["0x1", "latest", []]);
    // BNB Chain's base fee is always 0: the price is the suggested tip alone
    assert.equal(await gasPriceOf({}, { client: node() }), GWEI / 20n);
});
