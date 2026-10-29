import { network } from "hardhat";
import { expect } from "chai";
import { describeFork } from "./helpers/fork.js";
import { prepareUpgrade, upgradeOnFork } from "../lib/upgrade.js";

// scripts/upgrade.mjs's FORK=1 path on a fork of BNB Chain near its head (VH_UPGRADE_BLOCK, else
// 50 blocks under the archive's head): the new implementation deployed for the live proxy's
// registry and treasury, the Safe's call sent impersonated, the proxy checked, and wards through it
// that capture what the deployed contract's do, to the wei, and end as they do.
describeFork("The upgrade of the live proxy (fork)", function () {
    it("deploys, upgrades and wards through the proxy", async function () {
        this.timeout(0);
        const url = process.env.BSC_ARCHIVE_URL || "https://bsc-mainnet.public.blastapi.io";
        const head = process.env.VH_UPGRADE_BLOCK
            ? Number(process.env.VH_UPGRADE_BLOCK)
            : Number(BigInt((await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) })).json()).result)) - 50;
        const conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: head } } });
        const prepared = await prepareUpgrade(conn);
        for (const [what, pass] of prepared.checks) expect(pass, what).to.equal(true);
        const { checks, skewed, after, deployed } = await upgradeOnFork(conn, prepared);
        const gas = (ws) => ws.map((w) => `${w.bounty ?? "nothing"} (${w.gas} gas)`).join(", ");
        console.log(`      block ${head}: ${prepared.codeBytes} bytes; upgraded ${gas([skewed, ...after])}; deployed ${gas(deployed.wards)}`);
        for (const [what, pass] of checks) expect(pass, what).to.equal(true);
    });
});
