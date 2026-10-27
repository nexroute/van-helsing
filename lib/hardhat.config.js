import HardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import HardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import { configVariable, defineConfig } from "hardhat/config";

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
    },
    networks: {
        hardhat: {
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
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },
    // HH3 moved the mocha config under `test`; fork-replay tests need a long
    // timeout (cold forks + live calls).
    test: {
        mocha: { timeout: 2_000_000 },
    },
});
