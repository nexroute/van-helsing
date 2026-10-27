import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

// CurveLib's read of a stableswap, as a ward makes it (CurveLib.price and CurveLib.depth,
// through the harness's normalize): the price from get_dy, the depth a constant-product
// tangent from the pool's balances, mapped through coins() to the pair's (t0, t1) order.
// Deterministic, no fork. The sink path (approve + exchange) is tested end-to-end on a
// fork in curve-fork.test.js.

const Q96 = 2n ** 96n;
const ONE = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

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

describe("CurveLib price and depth (constant-product tangent)", function () {
    let conn, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        harness = await deploy(conn, "CurveLibHarness", null, [], { libraries: { CurveLib: null } });
    });

    it("prices off get_dy (peg), not the balances ratio; depth from balances", async function () {
        const b0 = 1000n * ONE;
        const b1 = 4000n * ONE; // balances ratio 4, but the mock's get_dy is 1:1 (peg)
        const pool = await deploy(conn, "MockCurvePool", null, [A, B, b0, b1]);
        const [s, l] = await harness.normalize(7, await pool.getAddress(), A, B);
        expect(s).to.equal(Q96); // price 1 from get_dy, NOT sqrt(4)*Q96 from balances
        expect(l).to.equal(isqrt(b0 * b1)); // conservative depth from balances
    });

    it("maps balances to (t0, t1) regardless of the pool's coin order", async function () {
        const bA = 1000n * ONE;
        const bB = 4000n * ONE;
        // pool stores coins as [B, A] with balances [bB, bA]; normalize(pool, A, B)
        // must still return A's balance as b0 and B's as b1.
        const pool = await deploy(conn, "MockCurvePool", null, [B, A, bB, bA]);
        const [b0, b1] = await harness.balances(await pool.getAddress(), A, B);
        expect(b0).to.equal(bA);
        expect(b1).to.equal(bB);
    });
});
