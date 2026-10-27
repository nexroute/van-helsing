import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyPoolIds } from "../src/identify.js";

const V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNIV3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const POOL = "0x6beb20557c2f9ef1327ef615c140cbf38440f630";
const POOLID = "0xa27e05a64e6e5b1d967438c6ce6a2796bb95c7396ca7c40ae35373f37d29b77f";

test("V2 pool -> padded address id", () => {
    const out = identifyPoolIds([{ address: POOL, topics: [V2] }]);
    assert.deepEqual(out, [{ kind: 0, id: "0x0000000000000000000000006beb20557c2f9ef1327ef615c140cbf38440f630" }]);
});

test("V4 singleton -> poolId from topic1", () => {
    const out = identifyPoolIds([{ address: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", topics: [V4, POOLID] }]);
    assert.deepEqual(out, [{ kind: 4, id: POOLID }]);
});

test("dedupes repeated pools, ignores non-swap logs, preserves order", () => {
    const out = identifyPoolIds([
        { address: POOL, topics: [UNIV3] },
        { address: "0xdead", topics: ["0xffff"] },
        { address: POOL, topics: [UNIV3] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 2);
});

test("a Curve pool's TokenExchange -> padded address id, kind 5 as the registry lists it", () => {
    const CURVE = "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140";
    const out = identifyPoolIds([{ address: POOL, topics: [CURVE, `0x${"0".repeat(64)}`] }]);
    assert.deepEqual(out, [{ kind: 5, id: "0x0000000000000000000000006beb20557c2f9ef1327ef615c140cbf38440f630" }]);
});
