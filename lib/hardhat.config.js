import HardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import HardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configVariable, defineConfig } from "hardhat/config";

// The chain the contracts are built for: BNB Chain by default, or VH_CHAIN. Builds differ only by
// contracts/libraries/Chain.sol, so another chain's build compiles a copy of contracts/ with that
// chain's own file (chains/<name>/Chain.sol) in its place, into artifacts and a cache of its own
// under .chains/<name>: no tracked file changes, and two chains' builds never mix.
const CHAIN = process.env.VH_CHAIN || "bnb";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function chainPaths() {
    if (CHAIN === "bnb") return { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" };
    const own = path.join(ROOT, "chains", CHAIN, "Chain.sol");
    if (!fs.existsSync(own)) throw new Error(`VH_CHAIN=${CHAIN}: there is no chains/${CHAIN}/Chain.sol`);
    const dir = path.join(ROOT, ".chains", CHAIN);
    fs.rmSync(path.join(dir, "contracts"), { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "contracts"), path.join(dir, "contracts"), { recursive: true });
    fs.copyFileSync(own, path.join(dir, "contracts", "libraries", "Chain.sol"));
    return { sources: `./.chains/${CHAIN}/contracts`, cache: `./.chains/${CHAIN}/cache`, artifacts: `./.chains/${CHAIN}/artifacts` };
}

// A deploy's two accounts: DEPLOYER_KEY sends the registry, the libraries and the implementation,
// VANITY_KEY the proxy alone, as its first transaction (ignition/modules/VanHelsing.js). Without
// the second, the deploy stops before the proxy rather than send it from the first.
const deployAccounts = () =>
    process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY, ...(process.env.VANITY_KEY ? [process.env.VANITY_KEY] : [])] : [];

export default defineConfig({
    plugins: [HardhatToolboxMochaEthers, HardhatNetworkHelpers],
    // BSC isn't a built-in EDR chain; give it a hardfork history so forked
    // execution at historical blocks knows the active hardfork (HH2 equivalent:
    // networks.hardhat.chains[56].hardforkHistory).
    chainDescriptors: {
        56: {
            name: "BNB Smart Chain",
            chainType: "l1",
            hardforkHistory: { cancun: { blockNumber: 0 } },
        },
        // Robinhood Chain, an Arbitrum Orbit chain: "generic", as its blocks carry Arbitrum's own
        // transaction types, with Cancun's opcodes from its first block.
        4663: {
            name: "Robinhood Chain",
            chainType: "generic",
            hardforkHistory: { cancun: { blockNumber: 0 } },
        },
    },
    networks: {
        // The default network is a fork of the chain the build is for.
        hardhat: CHAIN === "robinhood" ? {
            type: "edr-simulated",
            chainType: "generic",
            chainId: 4663,
            // A fork of Robinhood Chain: ROBINHOOD_RPC_URL, or the public RPC, which serves only the
            // last ~4,000 blocks' state (about seven minutes), so the fork starts at the head unless
            // ROBINHOOD_FORK_BLOCK pins a block that recent, or one an archive RPC serves.
            forking: process.env.VH_NO_FORK ? undefined : {
                url: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
                ...(process.env.ROBINHOOD_FORK_BLOCK ? { blockNumber: parseInt(process.env.ROBINHOOD_FORK_BLOCK, 10) } : {}),
            },
            hardfork: "cancun",
            gasPrice: 0,
            initialBaseFeePerGas: 0,
        } : {
            type: "edr-simulated",
            chainType: "l1",
            chainId: 56,
            // A fork of BNB Chain: BSC_ARCHIVE_URL if set, else the public Blast archive,
            // which serves the historical state the fork tests need. VH_NO_FORK=1 runs
            // without one, and the fork tests skip (test/helpers/fork.js).
            forking: process.env.VH_NO_FORK ? undefined : {
                url: process.env.BSC_ARCHIVE_URL || "https://bsc-mainnet.public.blastapi.io",
                // The idle fork block: each fork test resets to its own. Keep it recent and
                // finalized, above a truncated-history archive node's floor; override it
                // with BSC_FORK_BLOCK.
                blockNumber: parseInt(process.env.BSC_FORK_BLOCK || "103809024", 10),
            },
            hardfork: "cancun",
            gasPrice: 0,
            initialBaseFeePerGas: 0,
        },
        bsc: {
            type: "http",
            chainId: 56,
            // BNB Chain's own public RPC: a deploy goes through the public mempool, which is safe
            // for it (the proxy's address belongs to the vanity key alone, the proxy is created
            // initialized, and only the deployer holds the registry's roles until it hands them on).
            url: process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org",
            accounts: deployAccounts(),
            gasPrice: 50_000_000, // 0.05 gwei, the price BNB Chain's blocks include
            // Ignition prices BNB Chain by eth_maxPriorityFeePerGas, not gasPrice, and an RPC can
            // answer above the 0.05 gwei the chain takes, so both are pinned.
            ignition: { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 50_000_000n },
        },
        ethereum: {
            type: "http",
            chainId: 1,
            url: process.env.RPC_URL || "https://eth.llamarpc.com",
            accounts: deployAccounts(),
        },
        robinhood: {
            type: "http",
            chainId: 4663,
            url: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
            accounts: deployAccounts(),
        },
        base: {
            type: "http",
            chainId: 8453,
            url: process.env.RPC_URL || "https://mainnet.base.org",
            accounts: deployAccounts(),
        },
    },
    // Source verification on BscScan (and the other Etherscan explorers) through Etherscan's API,
    // with ETHERSCAN_API_KEY, read only when a verification runs.
    verify: { etherscan: { apiKey: configVariable("ETHERSCAN_API_KEY") } },
    paths: {
        ...chainPaths(),
        // Another chain's build runs its own suites alone (test/<name>/): the rest test BNB Chain's.
        tests: CHAIN === "bnb" ? "./test" : `./test/${CHAIN}`,
    },
    // HH3 moved the mocha config under `test`; fork-replay tests need a long
    // timeout (cold forks + live calls).
    test: {
        mocha: { timeout: 2_000_000 },
    },
});
