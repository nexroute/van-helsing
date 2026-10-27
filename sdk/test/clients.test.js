import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultClient, resolveClient } from "../src/clients.js";

test("defaultClient makes one viem client per chain slug, on an RPC that simulates, and reuses it", () => {
    const bsc = defaultClient("bsc");
    assert.equal(bsc, defaultClient("bsc"));
    assert.equal(bsc.chain.id, 56);
    assert.equal(bsc.transport.url, "https://bsc-dataseed.bnbchain.org");
    const ethereum = defaultClient("ethereum");
    assert.equal(ethereum.chain.id, 1);
    assert.equal(ethereum.transport.url, "https://ethereum-rpc.publicnode.com");
    assert.throws(() => defaultClient("solana"), /no default client for chain "solana": pass bsc \(56\) or ethereum \(1\), or a client/);
    assert.equal(defaultClient(56), bsc, "a chain id names the same client");
    assert.equal(defaultClient(1), ethereum);
    assert.throws(() => defaultClient(10), /no default client for chain 10: pass bsc \(56\) or ethereum \(1\), or a client/);
});

test("resolveClient takes the client passed, or the chain's default client, and refuses neither or a mismatch", async () => {
    const mine = { chain: { id: 56 } };
    assert.equal(await resolveClient({ client: mine }), mine);
    assert.equal(await resolveClient({ chain: "bsc" }), defaultClient("bsc"));
    assert.equal(await resolveClient({ client: mine, chain: "bsc" }), mine);
    await assert.rejects(resolveClient({}), /planWards: pass a client, a chain \(bsc or ethereum\) or a chainId \(56 or 1\)/);
    await assert.rejects(resolveClient({ client: mine, chain: "ethereum" }), /planWards: the client is on chain 56, not ethereum \(1\)/);
    const asked = { async getChainId() { return 1; } };
    assert.equal(await resolveClient({ client: asked, chain: "ethereum" }), asked);
});

test("resolveClient takes a chainId as it takes a chain, and refuses the two disagreeing", async () => {
    assert.equal(await resolveClient({ chainId: 56 }), defaultClient("bsc"));
    assert.equal(await resolveClient({ chainId: 1 }), defaultClient("ethereum"));
    assert.equal(await resolveClient({ chain: "bsc", chainId: 56 }), defaultClient("bsc"));
    await assert.rejects(resolveClient({ chainId: 10 }), /no default client for chain 10/);
    await assert.rejects(resolveClient({ chain: "bsc", chainId: 1 }), /planWards: chain bsc is not chainId 1/);
    const mine = { chain: { id: 56 } };
    assert.equal(await resolveClient({ client: mine, chainId: 56 }), mine);
    await assert.rejects(resolveClient({ client: mine, chainId: 1 }), /planWards: the client is on chain 56, not ethereum \(1\)/);
});
