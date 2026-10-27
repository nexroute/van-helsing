import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../src/index.js";

test("package exposes the public API", () => {
    assert.equal(typeof sdk.planWards, "function");
    assert.equal(typeof sdk.simulate, "function");
    assert.equal(typeof sdk.identifyPoolIds, "function");
    assert.equal(typeof sdk.buildWards, "function");
    assert.ok(Array.isArray(sdk.WARD_ABI));
});
