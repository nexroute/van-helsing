// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

// Robinhood Chain's copy of contracts/libraries/Chain.sol, compiled in its place with
// VH_CHAIN=robinhood (lib/hardhat.config.js): WETH, Uniswap v4's PoolManager, PancakeSwap
// Infinity's Vault and CLPoolManager, the treasury Tessera pays out of there, and Algebra
// Integral's pools (Alandale, Sheriff and AEON run them), which its build trades.
library Chain {
    address internal constant WRAPPED_NATIVE = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // WETH
    address internal constant UNI_V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant INFINITY_VAULT = 0xFe7E25dE55e5cBbEcCcb661F3679F873f72B9b0D;
    address internal constant INFINITY_CL_POOL_MANAGER = 0xd01C774d4A66408326Bc65728Ac5Ae5aAf004032;
    address internal constant TESSERA_TREASURY = 0x907d1D174569b11624bdcEfD20dcEF27600237f8;
    uint8 internal constant ALGEBRA = 1; // Algebra Integral pools traded (contracts/libraries/Chain.sol)
}
