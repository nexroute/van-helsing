import { expect } from "chai";
import { twoPassCombine } from "./lib/capture.js";

describe("VanHelsing two-pass combine (directional)", function () {
    it("driver keeps the DEEPER read (max), sink keeps the SHALLOWER read (min)", function () {
        expect(twoPassCombine(3n, 7n, true)).to.equal(7n); // driver: max(3, 7)
        expect(twoPassCombine(3n, 7n, false)).to.equal(3n); // sink: min(3, 7)
        expect(twoPassCombine(7n, 3n, true)).to.equal(7n); // order-independent: still max
        expect(twoPassCombine(7n, 3n, false)).to.equal(3n); // still min
    });
    it("is unchanged when both liquidities are equal, either direction (uniform leg: pass-2 == pass-1)", function () {
        expect(twoPassCombine(7n, 7n, true)).to.equal(7n);
        expect(twoPassCombine(7n, 7n, false)).to.equal(7n);
        expect(twoPassCombine(10n ** 30n, 10n ** 30n, true)).to.equal(10n ** 30n);
        expect(twoPassCombine(10n ** 30n, 10n ** 30n, false)).to.equal(10n ** 30n);
    });
    it("a cliffy driver (pass-2 core > pass-1 skirt-diluted) recovers the core; the same sink stays conservative", function () {
        const pass1 = 10n ** 22n, pass2core = 10n ** 26n; // pass-1 low (skirt-diluted), pass-2 high (core)
        expect(twoPassCombine(pass1, pass2core, true)).to.equal(pass2core); // driver recovers the core
        expect(twoPassCombine(pass1, pass2core, false)).to.equal(pass1); // sink keeps the shallower
    });
    it("a barely-moving driver (pass-2 notch << pass-1) keeps the deep pass-1 read, never the notch", function () {
        const pass1deep = 10n ** 26n, pass2notch = 10n ** 22n; // driver read a thin notch on the short re-walk
        expect(twoPassCombine(pass1deep, pass2notch, true)).to.equal(pass1deep); // NOT the notch: max guards it
    });
});
