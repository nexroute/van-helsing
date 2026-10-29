import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS, nativeWorth } from "../src/value.js";

const ONE = 10n ** 18n;
const usd = (n) => BigInt(n) * 10n ** 8n; // a Chainlink dollar price, 8 decimals
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8"; // Binance-Peg ETH on BNB Chain

test("BNB Chain: WBNB one for one, the hub stablecoins at their peg", () => {
    const worth = nativeWorth(CHAINS[56], { native: usd(800) });
    assert.equal(worth("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", ONE), ONE);
    const stables = {
        USDT: "0x55d398326f99059fF775485246999027B3197955",
        USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
        U: "0xcE24439F2D9C6a2289F741120FE202248B666666",
        USD1: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
        FDUSD: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
    };
    for (const [symbol, token] of Object.entries(stables)) assert.equal(worth(token, 800n * ONE), ONE, symbol);
    assert.equal(worth("0x0000000000000000000000000000000000000dd0", ONE), null);
});

test("BNB Chain: ETH through its own dollar feed", () => {
    assert.equal(nativeWorth(CHAINS[56], { native: usd(800), tokens: { [ETH]: usd(2400) } })(ETH, ONE), 3n * ONE);
    assert.equal(nativeWorth(CHAINS[56], { native: usd(800) })(ETH, ONE), null, "no price without its feed");
});

test("Ethereum: WETH one for one, USDC and USDT with 6 decimals, DAI with 18", () => {
    const worth = nativeWorth(CHAINS[1], { native: usd(2000) });
    assert.equal(worth("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", ONE), ONE);
    assert.equal(worth("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 2000n * 10n ** 6n), ONE, "USDC");
    assert.equal(worth("0xdAC17F958D2ee523a2206206994597C13D831ec7", 2000n * 10n ** 6n), ONE, "USDT");
    assert.equal(worth("0x6B175474E89094C44Da98b954EedeAC495271d0F", 2000n * ONE), ONE, "DAI");
});

test("Robinhood Chain: WETH one for one, USDG with 6 decimals", () => {
    const worth = nativeWorth(CHAINS[4663], { native: usd(2000) });
    assert.equal(worth("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", ONE), ONE, "WETH");
    assert.equal(worth("0x5fc5360D0400a0fD4f2aF552AdD042d716F1D168", 2000n * 10n ** 6n), ONE, "USDG");
    assert.equal(worth("0x0000000000000000000000000000000000000dd0", ONE), null);
});

test("no stablecoin price without the native token's feed", () => {
    assert.equal(nativeWorth(CHAINS[56], { native: null })("0x55d398326f99059fF775485246999027B3197955", ONE), null);
});

test("a bare native price still works, as nativeWorth took it before", () => {
    assert.equal(nativeWorth(CHAINS[56], usd(800))("0x55d398326f99059fF775485246999027B3197955", 800n * ONE), ONE);
});
