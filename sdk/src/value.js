import { encodeFunctionData, decodeFunctionResult } from "viem";

// What an amount of a token is worth in the chain's native token, the unit gas is paid in, so a
// ward can be weighed against its own gas and the insurance against the swap. VanHelsing pays
// every bounty in a hub token: the wrapped native token, a dollar stablecoin, or a token with a
// Chainlink dollar feed. A stablecoin is valued at one dollar through the chain's Chainlink
// native/USD feed, a feed token at its own feed's price, both read in the same simulation as the
// wards. Decimals belong to each token on each chain: USDC has 18 on BNB Chain and 6 on Ethereum.
export const CHAINS = {
    56: {
        wrapped: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
        usdFeed: "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee", // Chainlink BNB / USD, 8 decimals
        // dollar stablecoins: token -> decimals
        stables: {
            "0x55d398326f99059ff775485246999027b3197955": 18, // USDT
            "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18, // USDC
            "0xe9e7cea3dedca5984780bafc599bd69add087d56": 18, // BUSD
            "0xce24439f2d9c6a2289f741120fe202248b666666": 18, // U
            "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": 18, // USD1
            "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": 18, // FDUSD
        },
        // tokens priced through their own Chainlink dollar feed: token -> [decimals, feed]
        feeds: {
            "0x2170ed0880ac9a755fd29b2688956bd959f933f8": [18, "0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e"], // ETH, ETH / USD
        },
    },
    1: {
        wrapped: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
        usdFeed: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", // Chainlink ETH / USD, 8 decimals
        stables: {
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC
            "0xdac17f958d2ee523a2206206994597c13d831ec7": 6, // USDT
            "0x6b175474e89094c44da98b954eedeac495271d0f": 18, // DAI
            "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": 18, // USD1
            "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": 18, // FDUSD
        },
        feeds: {},
    },
};

const FEED_ABI = [
    {
        type: "function",
        name: "latestRoundData",
        inputs: [],
        outputs: [
            { type: "uint80", name: "roundId" },
            { type: "int256", name: "answer" },
            { type: "uint256", name: "startedAt" },
            { type: "uint256", name: "updatedAt" },
            { type: "uint80", name: "answeredInRound" },
        ],
        stateMutability: "view",
    },
];
const FEED_DECIMALS = 8n;
const LATEST_ROUND = encodeFunctionData({ abi: FEED_ABI, functionName: "latestRoundData" });

// The calls that read a chain's dollar prices, to run alongside the wards: its native/USD feed
// first, then each feed token's.
export function feedCalls(chain) {
    if (!chain?.usdFeed) return [];
    return [chain.usdFeed, ...Object.values(chain.feeds || {}).map(([, feed]) => feed)].map((to) => ({ to, data: LATEST_ROUND }));
}

// The prices feedCalls' results answer: { native, tokens: { token: price } }, each in dollars
// with the feeds' 8 decimals, or null where a feed failed or answered nothing usable.
export function readPrices(chain, results) {
    const tokens = Object.keys(chain?.feeds || {});
    return {
        native: readUsdPrice(results[0]),
        tokens: Object.fromEntries(tokens.map((token, i) => [token, readUsdPrice(results[i + 1])])),
    };
}

// One feed's price in dollars, with the feed's 8 decimals, or null when the call failed or
// answered nothing usable.
export function readUsdPrice(result) {
    if (!result || result.reverted || !result.returnData || result.returnData === "0x") return null;
    const [, answer] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: result.returnData });
    return answer > 0n ? answer : null;
}

// worth(token, amount) in native wei: the wrapped native token one for one, a stablecoin at a
// dollar and a feed token at its feed's price, both through the native token's dollar price,
// anything else null. `prices` is what readPrices returns, or the native token's dollar price
// alone.
export function nativeWorth(chain, prices) {
    if (typeof prices === "bigint") prices = { native: prices };
    const native = prices?.native ?? null;
    const fed = Object.fromEntries(Object.entries(prices?.tokens || {}).map(([t, p]) => [t.toLowerCase(), p]));
    const scale = (amount, decimals) => (decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18));
    return (token, amount) => {
        const t = (token || "").toLowerCase();
        if (chain && t === chain.wrapped) return amount;
        if (!chain || !native) return null;
        const stable = chain.stables?.[t];
        if (stable !== undefined) return (scale(amount, stable) * 10n ** FEED_DECIMALS) / native;
        const feed = chain.feeds?.[t];
        if (feed && fed[t]) return (scale(amount, feed[0]) * fed[t]) / native;
        return null;
    };
}
