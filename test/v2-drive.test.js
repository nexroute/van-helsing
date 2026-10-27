import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

// V2Lib.driveAmount must move a constant-product pool to an exact target marginal
// price, fee-aware. Then "normalize -> meet -> flashDrive" reproduces the two-pool
// optimum for V2 legs too (MeetingPrice is exact for constant product), so V2 needs no
// closed form of its own. Deterministic mocks.

const Q96 = 2n ** 96n;

function isqrt(n) {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}
// sqrt(r1/r0) * Q96, as an integer sqrtPriceX96
const sqrtPrice = (r0, r1) => isqrt((r1 * Q96 * Q96) / r0);
const rand = (lo, hi) => lo + ((hi - lo) * BigInt(Math.floor(Math.random() * 2 ** 45))) / 2n ** 45n;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const abs = (x) => (x < 0n ? -x : x);

describe("V2Lib.driveAmount (fee-aware drive to a target price)", function () {
    let harness;

    before(async function () {
        const conn = await network.create({ network: "hardhat" });
        harness = await deploy(conn, "V2LibHarness");
    });

    it("reaches the target marginal price across random pools, both directions", async function () {
        let worst = 0;
        let checked = 0;
        for (let i = 0; i < 800; i++) {
            const r0 = rand(2n ** 40n, 2n ** 100n);
            const r1 = rand(2n ** 40n, 2n ** 100n);
            const fee = pick([25n, 20n, 30n, 100n, 1n]);
            const fn = 10000n - fee;
            const fd = 10000n;
            const cur = sqrtPrice(r0, r1);

            const zeroForOne = i % 2 === 0; // even: lower price; odd: raise price
            const num = zeroForOne ? rand(30n, 98n) : rand(102n, 300n);
            const target = (cur * num) / 100n;
            if (target <= 4295128740n || target >= 1461446703485210103287273052203988822378723970341n) continue;

            const a = await harness.driveAmount(r0, r1, fn, fd, target, zeroForOne);
            if (a === 0n) continue;

            const [rIn, rOut] = zeroForOne ? [r0, r1] : [r1, r0];
            const out = await harness.amountOut(a, rIn, rOut, fn, fd);
            if (out >= rOut) continue; // would drain the pool (degenerate)
            const r0n = zeroForOne ? r0 + a : r0 - out;
            const r1n = zeroForOne ? r1 - out : r1 + a;
            const res = sqrtPrice(r0n, r1n);

            const rel = Number(abs(res - target)) / Number(target);
            worst = Math.max(worst, rel);
            checked++;
            if (rel >= 1e-3) {
                throw new Error(`rel ${rel} r0=${r0} r1=${r1} fee=${fee} zfo=${zeroForOne} target=${target} res=${res} a=${a}`);
            }
        }
        console.log(`  checked ${checked}, worst rel err: ${worst.toExponential(2)}`);
        expect(checked).to.be.gt(300);
    });
});
