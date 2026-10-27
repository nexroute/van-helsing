import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

// The meeting-price target sizes a restore from the two pools' marginal prices and
// liquidity. Down-restores (sd >= sa) meet at the arithmetic mean of the
// sqrt prices, up-restores (sd < sa) at the harmonic mean; both weight toward the
// deeper pool so a defended pool deeper than its alt is not overshot into a loss.
// Tested as a pure formula so the branch, weighting, and fallbacks are pinned
// deterministically, no fork.

describe("MeetingPrice", function () {
    let mp;

    before(async function () {
        const conn = await network.create({ network: "hardhat" });
        mp = await deploy(conn, "MeetingPriceHarness");
    });

    it("down-restore (sd >= sa) is the arithmetic mean", async function () {
        expect(await mp.meet(200n, 1n, 100n, 1n)).to.equal(150n); // (200+100)/2
        expect(await mp.meet(200n, 3n, 100n, 1n)).to.equal(175n); // (3*200+100)/4, toward deeper sd
        expect(await mp.meet(200n, 1n, 100n, 3n)).to.equal(125n); // (200+3*100)/4, toward deeper sa
    });

    it("up-restore (sd < sa) is the harmonic mean, below the arithmetic mean", async function () {
        // w = (ld*sa + la*sd)/lsum, T = sd*sa/w
        expect(await mp.meet(100n, 1n, 200n, 1n)).to.equal(133n); // 100*200 / ((200+100)/2) = 20000/150
        expect(await mp.meet(100n, 3n, 200n, 1n)).to.equal(114n); // w=(3*200+100)/4=175, 20000/175, toward sd
    });

    it("barely moves the defended pool when the alt is much shallower (no overshoot)", async function () {
        const lo = 10n ** 27n;
        const hi = 2n * 10n ** 27n;
        const bigL = 10n ** 24n;
        // down-restore: defended at hi, shallow alt at lo -> T stays at hi
        const down = await mp.meet(hi, bigL, lo, 1n);
        expect(hi - down).to.be.lt(10n ** 4n);
        // up-restore: defended at lo, shallow alt at hi -> T stays at lo
        const up = await mp.meet(lo, bigL, hi, 1n);
        expect(up - lo).to.be.lt(10n ** 4n);
    });

    it("pulls to the alt's price when the alt is much deeper (near-full restore)", async function () {
        const lo = 10n ** 27n;
        const hi = 2n * 10n ** 27n;
        const bigL = 10n ** 24n;
        // down-restore: defended at hi, deep alt at lo -> T pulled to lo
        const down = await mp.meet(hi, 1n, lo, bigL);
        expect(down - lo).to.be.lt(10n ** 4n);
        // up-restore: defended at lo, deep alt at hi -> T pulled to hi
        const up = await mp.meet(lo, 1n, hi, bigL);
        expect(hi - up).to.be.lt(10n ** 4n);
    });

    it("falls back to the alt's price when the alt tick is empty (la == 0)", async function () {
        // la == 0 must not read as zero capacity (which would give T = sd = no arb);
        // it restores to the alt's price so the alt sale can cross the empty gap.
        expect(await mp.meet(100n, 5n, 777n, 0n)).to.equal(777n);
        expect(await mp.meet(777n, 5n, 100n, 0n)).to.equal(100n);
    });

    it("returns the defended price when neither pool has liquidity", async function () {
        expect(await mp.meet(4242n, 0n, 9999n, 0n)).to.equal(4242n);
    });

    it("does not overflow at max sqrt price with large liquidity, in either direction", async function () {
        const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
        const down = await mp.meet(MAX_SQRT, 2n ** 120n, MAX_SQRT / 2n, 2n ** 100n);
        expect(down).to.be.lte(MAX_SQRT);
        expect(down).to.be.gte(MAX_SQRT / 2n);
        const up = await mp.meet(MAX_SQRT / 2n, 2n ** 120n, MAX_SQRT, 2n ** 100n);
        expect(up).to.be.gte(MAX_SQRT / 2n);
        expect(up).to.be.lte(MAX_SQRT);
    });
});
