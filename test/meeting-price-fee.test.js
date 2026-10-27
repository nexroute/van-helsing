import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";

// Fuzz the fee-aware meeting price against a float reference that was itself
// validated against a brute-force profit maximiser.
// Down-restores meet at the fee-adjusted arithmetic form, up-restores at the
// harmonic form; gamma = 1/sqrt((1-fd)(1-fa)) is the fee wedge.

const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

function refT(sd, ld, nd, dd, sa, la, na, da) {
    const [SD, LD, ND, DD, SA, LA, NA, DA] = [sd, ld, nd, dd, sa, la, na, da].map(Number);
    const g = 1 / Math.sqrt((ND / DD) * (NA / DA));
    const vfa = NA / DA;
    if (SD >= SA) {
        const saf = (vfa * LD * SD + LA * SA) / (LA + vfa * g * LD);
        return g * saf; // down
    }
    return (LA / g + vfa * LD) / (LA / SA + (vfa * LD) / SD); // up
}

const rand = (lo, hi) => {
    const span = hi - lo;
    // 15 random hex digits of resolution, scaled into [lo,hi)
    const r = BigInt(Math.floor(Math.random() * 2 ** 45));
    return lo + (span * r) / (2n ** 45n);
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

describe("MeetingPrice.targetFee (fuzz)", function () {
    let mp;
    before(async function () {
        const conn = await network.create({ network: "hardhat" });
        mp = await deploy(conn, "MeetingPriceHarness");
    });

    it("matches the reference across random realistic pools, both directions", async function () {
        let worst = 0;
        for (let i = 0; i < 500; i++) {
            const sd = rand(2n ** 80n, 2n ** 105n);
            const sa = rand(2n ** 80n, 2n ** 105n);
            const ld = rand(2n ** 55n, 2n ** 95n);
            const la = rand(2n ** 55n, 2n ** 95n);
            const dd = pick([1000000n, 10000n]);
            const da = pick([1000000n, 10000n]);
            const nd = dd - rand(0n, dd / 100n); // fee up to ~1%
            const na = da - rand(0n, da / 100n);
            const got = Number(await mp.meetFee(sd, ld, nd, dd, sa, la, na, da));
            // The contract clamps into [min(sd,sa), max(sd,sa)]; clamp the float
            // reference the same way before comparing, since refT itself can land
            // outside that interval on near-sub-fee draws.
            const lo = Number(sd < sa ? sd : sa), hi = Number(sd < sa ? sa : sd);
            const ref = Math.min(Math.max(refT(sd, ld, nd, dd, sa, la, na, da), lo), hi);
            const rel = Math.abs(got - ref) / ref;
            worst = Math.max(worst, rel);
            if (rel >= 1e-3) {
                throw new Error(`rel ${rel} at sd=${sd} sa=${sa} ld=${ld} la=${la} nd/dd=${nd}/${dd} na/da=${na}/${da} got=${got} want=${ref}`);
            }
        }
        console.log("  worst rel err (realistic):", worst.toExponential(2));
    });

    it("returns both pools' final prices, gamma apart (saFinal for driving the alt)", async function () {
        let worst = 0;
        let clamped = 0;
        for (let i = 0; i < 300; i++) {
            const sd = rand(2n ** 80n, 2n ** 105n);
            const sa = rand(2n ** 80n, 2n ** 105n);
            const ld = rand(2n ** 55n, 2n ** 95n);
            const la = rand(2n ** 55n, 2n ** 95n);
            const dd = pick([1000000n, 10000n]);
            const da = pick([1000000n, 10000n]);
            const nd = dd - rand(0n, dd / 100n);
            const na = da - rand(0n, da / 100n);
            const [sdF, saF] = await mp.meetBoth(sd, ld, nd, dd, sa, la, na, da);
            // sdFinal and saFinal are clamped INDEPENDENTLY into [min(sd,sa),
            // max(sd,sa)]. On a sub-fee draw one side can pin to a live price while
            // the other keeps its raw value, so the exact gamma relationship only
            // holds away from that pinning; the pinned regime is covered by the
            // sub-fee tests below and by the clamp-aware reference fuzz. Detect
            // pinning directly from the outputs (a continuous random draw landing
            // exactly on sd/sa otherwise has vanishing probability) and skip the
            // ratio check there.
            if (sdF === sd || sdF === sa || saF === sd || saF === sa) { clamped++; continue; }
            const g = 1 / Math.sqrt((Number(nd) / Number(dd)) * (Number(na) / Number(da)));
            // down: saFinal = sdFinal/gamma ; up: saFinal = sdFinal*gamma
            const want = sd >= sa ? Number(sdF) / g : Number(sdF) * g;
            const rel = Math.abs(Number(saF) - want) / want;
            worst = Math.max(worst, rel);
            expect(rel).to.be.lt(1e-6);
        }
        console.log(`  worst saFinal rel err: ${worst.toExponential(2)} (${clamped} of 300 draws pinned by the clamp, skipped)`);
    });

    it("stays within [min,max] and never reverts at extreme prices/liquidity", async function () {
        const L = 2n ** 127n;
        const cases = [
            [MAX_SQRT, L, 999900n, 1000000n, 4295128740n, 1n, 9975n, 10000n], // extreme down, deep vs empty-ish
            [4295128740n, 1n, 9975n, 10000n, MAX_SQRT, L, 999900n, 1000000n], // extreme up
            [MAX_SQRT, L, 990000n, 1000000n, MAX_SQRT / 2n, L, 990000n, 1000000n], // big fees, both deep
            [2n ** 100n, L, 999900n, 1000000n, 2n ** 159n, L, 9975n, 10000n], // up, wide gap
        ];
        for (const c of cases) {
            const got = await mp.meetFee(...c);
            const lo = c[0] < c[4] ? c[0] : c[4];
            const hi = c[0] < c[4] ? c[4] : c[0];
            expect(got >= lo - 8n && got <= hi + 8n).to.equal(true);
        }
    });

    it("saturates the driven final to MAX_SQRT instead of wrapping past 2^160", async function () {
        const MAX = 1461446703485210103287273052203988822378723970341n;
        const L = 10n ** 24n;
        // down-restore with both legs at the top tick: sdFinal = gamma*saf > MAX_SQRT
        const [sdF, saF] = await mp.meetBoth(MAX, L, 990000n, 1000000n, MAX - 1000n, L, 990000n, 1000000n);
        expect(sdF).to.be.lte(MAX);
        expect(saF).to.be.lte(MAX);
        expect(sdF).to.be.gt(0n); // not wrapped to a small garbage value
    });

    it("falls back to the alt price when the alt tick is empty (la == 0)", async function () {
        expect(await mp.meetFee(100n, 5n, 999900n, 1000000n, 777n, 0n, 9975n, 10000n)).to.equal(777n);
        expect(await mp.meetFee(100n, 0n, 999900n, 1000000n, 777n, 0n, 9975n, 10000n)).to.equal(100n);
    });

    it("with zero fees equals the fee-free meeting price", async function () {
        // nd==dd, na==da => gamma=1 => same as target()
        const sd = 2n ** 96n * 3n, sa = 2n ** 96n * 2n, ld = 5n * 10n ** 23n, la = 9n * 10n ** 23n;
        const feeAware = await mp.meetFee(sd, ld, 1000000n, 1000000n, sa, la, 1000000n, 1000000n);
        const feeFree = await mp.meet(sd, ld, sa, la);
        const d = feeAware > feeFree ? feeAware - feeFree : feeFree - feeAware;
        expect(d).to.be.lt(1n << 40n); // equal up to fixed-point rounding
    });

    // The gamma wedge must never push a final OUTSIDE the two live prices.
    // A sub-fee dislocation (spread smaller than the round-trip fee) has no
    // profitable arb; the clamp pins the driven pool's final to its own live price
    // so VanHelsing's cur != target guard reads it as NO_ARB instead of attempting
    // a doomed drive.
    it("pins the finals to the live prices on a sub-fee dislocation (down-restore)", async function () {
        const sa = 1n << 96n;
        const sd = (sa * 10001n) / 10000n; // 0.01% apart, fees 2x0.25% -> gamma ~1.0025
        const L = 10n ** 24n;
        const [sdF, saF] = await mp.meetBoth(sd, L, 9975n, 10000n, sa, L, 9975n, 10000n);
        expect(sdF).to.equal(sd); // clamped to the defended's own price -> NO_ARB
        // saf's raw weighted average also lands outside [sa, sd] here (the fee discount
        // outweighs the tiny dislocation), so the clamp pins saF too, to the ALT's own
        // live price exactly, not just somewhere in range. VanHelsing drives the ALT to
        // saFinal whenever the defended cannot flash (the stable-defended shape), so this
        // pin matters as much as sdF's.
        expect(saF).to.equal(sa);
    });

    it("pins the finals to the live prices on a sub-fee dislocation (up-restore)", async function () {
        const sa = 1n << 96n;
        const sd = (sa * 9999n) / 10000n; // defended below the alt, still sub-fee
        const L = 10n ** 24n;
        const [sdF, saF] = await mp.meetBoth(sd, L, 9975n, 10000n, sa, L, 9975n, 10000n);
        expect(sdF).to.equal(sd);
        // saFinal = gamma*sdFinal here, and gamma*sd overshoots past sa, so it clamps to
        // the ALT's own live price exactly, same reasoning as the down case above.
        expect(saF).to.equal(sa);
    });

    it("pins saF to the alt's own live price on a sub-fee dislocation (legs swapped)", async function () {
        // The down-restore case above with sd/sa magnitudes exchanged: the ALT (sa) now
        // carries the +0.01% bump and the DEFENDED (sd) sits at the base price, which
        // flips this into the up-restore branch (sd < sa). Still sub-fee, and still a
        // clamp-binds-on-the-alt-side case, checked from the other side of the down/up
        // split.
        const sd = 1n << 96n;
        const sa = (sd * 10001n) / 10000n;
        const L = 10n ** 24n;
        const [, saF] = await mp.meetBoth(sd, L, 9975n, 10000n, sa, L, 9975n, 10000n);
        expect(saF).to.equal(sa);
    });

    it("leaves a clearly profitable meet strictly inside the interval", async function () {
        const sa = 1n << 96n;
        const sd = 2n * sa; // 4x price dislocation, fees 2x0.05%
        const L = 10n ** 24n;
        const [sdF, saF] = await mp.meetBoth(sd, L, 999500n, 1000000n, sa, L, 999500n, 1000000n);
        expect(sdF > sa && sdF < sd).to.equal(true);
        expect(saF > sa && saF < sd).to.equal(true);
    });

    // noArb is true exactly when the sqrt-price ratio is within the round-trip fee
    // wedge gamma = 1/sqrt((nd/dd)(na/da)). Fees as (num, den): V3 0.05% = (999500, 1e6).
    it("noArb: true when the price gap is within the round-trip fee, false above it", async function () {
        const nd = 999500n, dd = 1000000n, na = 999500n, da = 1000000n; // 0.05% each leg
        const sa = 1n << 96n;
        // gamma = 1/sqrt(0.9995*0.9995) = 1/0.9995 ~= 1.00050025, so the wedge on the sqrt
        // price ratio is ~0.05%. Pick values clearly inside / outside it (not on the edge).
        const subFee = sa + sa / 5000n;   // +0.02%, clearly inside the ~0.05% wedge -> no arb
        const supraFee = sa + sa / 500n;  // +0.2%, clearly past the wedge -> arb possible
        expect(await mp.noArb(subFee, nd, dd, sa, na, da)).to.equal(true);
        expect(await mp.noArb(supraFee, nd, dd, sa, na, da)).to.equal(false);
        // symmetric in the two legs (order does not matter)
        expect(await mp.noArb(sa, na, da, subFee, nd, dd)).to.equal(true);
        expect(await mp.noArb(sa, na, da, supraFee, nd, dd)).to.equal(false);
        // equal prices -> trivially within the wedge -> no arb
        expect(await mp.noArb(sa, nd, dd, sa, na, da)).to.equal(true);
    });
});
