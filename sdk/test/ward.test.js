import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from "viem";
import { wardCall, buildWards, WARD_ABI } from "../src/ward.js";

const VH = "0x000000000000000000000000000000000000dEaD";
const id = "0xa27e05a64e6e5b1d967438c6ce6a2796bb95c7396ca7c40ae35373f37d29b77f";
const ZERO = "0x0000000000000000000000000000000000000000";
const ALICE = "0x00000000000000000000000000000000000A11cE";
const wardAbi = [{
    type: "function", name: "ward", outputs: [], stateMutability: "nonpayable",
    inputs: [{ type: "bytes32", name: "id" }, { type: "address", name: "payee" }],
}];

test("WARD_ABI has one ward, ward(id, payee)", () => {
    const wards = WARD_ABI.filter((f) => f.type === "function" && f.name === "ward");
    assert.equal(wards.length, 1);
    assert.deepEqual(wards[0].inputs.map((i) => i.type), ["bytes32", "address"]);
    assert.deepEqual(wards[0].inputs.map((i) => i.name), ["id", "payee"]);
    const data = encodeFunctionData({ abi: WARD_ABI, functionName: "ward", args: [id, ALICE] });
    assert.equal(data.slice(0, 10), toFunctionSelector("ward(bytes32,address)"));
    assert.equal(data.length, 2 + 2 * (4 + 64));
});

test("builds one ward(id, payee) call per pool, paying whoever sends it", () => {
    const out = buildWards([{ kind: 4, id }], { vanHelsing: VH });
    assert.equal(out.length, 1);
    assert.equal(out[0].to, VH);
    assert.equal(out[0].id, id);
    assert.equal(out[0].anchor, undefined, "the registry's deepest pool anchors, never the caller");
    assert.equal(out[0].data, encodeFunctionData({ abi: wardAbi, functionName: "ward", args: [id, ZERO] }));
});

test("pays the bounty to the given payee", () => {
    const b = wardCall({ kind: 0, id }, { vanHelsing: VH, payee: ALICE });
    assert.deepEqual(decodeFunctionData({ abi: WARD_ABI, data: b.data }).args, [id, ALICE]);
});

test("throws when vanHelsing is missing", () => {
    assert.throws(() => buildWards([{ kind: 0, id }], {}), /vanHelsing address is required/);
});
