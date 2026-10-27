import { createPublicClient, http } from "viem";
import { bsc, mainnet } from "viem/chains";

// The chains planWards knows by slug or chain id, each with a public RPC that serves
// eth_simulateV1 with state overrides and traced transfers (checked 2026-10-22; viem's own
// defaults did not all). A public RPC sees the unsigned swap before it is sent, and limits how
// often it is asked, so a wallet or a router in production passes a client on its own node instead.
// `nextBlock` is how many seconds after a block the next one is stamped: BNB Chain makes a block
// every 0.45 s, so the next one is within the second, and Ethereum one every 12 s.
export const RPCS = {
    bsc: { chain: bsc, url: "https://bsc-dataseed.bnbchain.org", nextBlock: 1 },
    ethereum: { chain: mainnet, url: "https://ethereum-rpc.publicnode.com", nextBlock: 12 },
};

const KNOWN = Object.entries(RPCS).map(([slug, rpc]) => `${slug} (${rpc.chain.id})`).join(" or ");
const made = new Map();

// The slug of a chain named by its slug or its chain id, or undefined for one it does not know.
function slugOf(chain) {
    if (typeof chain === "string") return Object.hasOwn(RPCS, chain) ? chain : undefined;
    return Object.keys(RPCS).find((slug) => RPCS[slug].chain.id === Number(chain));
}

// How many seconds after a block the chain stamps the next one: one on a chain the SDK does not
// know, the least eth_simulateV1 takes.
export function secondsToNextBlock(chainId) {
    const slug = slugOf(Number(chainId));
    return slug ? RPCS[slug].nextBlock : 1;
}

// The viem public client for a chain slug or chain id, made once and reused.
export function defaultClient(chain) {
    const slug = slugOf(chain);
    if (!slug) throw new Error(`no default client for chain ${typeof chain === "string" ? `"${chain}"` : chain}: pass ${KNOWN}, or a client`);
    if (!made.has(slug)) made.set(slug, createPublicClient({ chain: RPCS[slug].chain, transport: http(RPCS[slug].url) }));
    return made.get(slug);
}

// The client to work with: the one passed, or the default client of the chain named by `chain`
// or `chainId`. Naming none is an error, and so are a chain and a chainId that disagree, or a
// client on another chain than the one named. `who` names the caller in the errors.
export async function resolveClient({ client, chain, chainId }, who = "planWards") {
    if (chain !== undefined && chainId !== undefined && slugOf(chain) !== slugOf(chainId)) {
        throw new Error(`${who}: chain ${chain} is not chainId ${chainId}`);
    }
    const named = chain ?? chainId;
    if (!client && named === undefined) {
        throw new Error(`${who}: pass a client, a chain (${Object.keys(RPCS).join(" or ")}) or a chainId (${Object.values(RPCS).map((r) => r.chain.id).join(" or ")})`);
    }
    if (!client) return defaultClient(named);
    if (named !== undefined) {
        const slug = slugOf(named) ?? defaultClient(named); // an unknown chain throws, naming those it knows
        const want = RPCS[slug].chain.id;
        const id = client.chain?.id ?? (await client.getChainId());
        if (Number(id) !== want) throw new Error(`${who}: the client is on chain ${id}, not ${slug} (${want})`);
    }
    return client;
}
