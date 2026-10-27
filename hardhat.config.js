import { defineConfig } from "hardhat/config";
import HardhatIgnitionEthers from "@nomicfoundation/hardhat-ignition-ethers";
import config from "./lib/hardhat.config.js";

export default defineConfig({
    ...config,
    plugins: [...(config.plugins ?? []), HardhatIgnitionEthers],
    solidity: {
        // ward() runs inside other transactions, so optimize hard for runtime gas: 1e6 runs
        // is the practical ceiling (the optimizer saturates past it). VanHelsing stays under
        // the 24KB limit with its libraries linked out.
        compilers: [{
            version: "0.8.27",
            settings: {
                optimizer: { enabled: true, runs: 1000000 },
                evmVersion: "cancun",
            },
        }],
        // Contracts the tests and the deploy reach by name (getContractAt, Ignition) that no
        // project source compiles: Hardhat 3 emits artifacts only for project sources and
        // these.
        npmFilesToBuild: [
            "@openzeppelin/contracts/token/ERC20/IERC20.sol",
            // VanHelsing ships behind OpenZeppelin's transparent proxy (ignition/modules/VanHelsing.js)
            "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
            "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
        ],
    },
});
