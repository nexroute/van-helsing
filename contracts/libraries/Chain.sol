// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

// The addresses Van Helsing depends on that differ from chain to chain, here BNB Chain's: the
// wrapped native currency, Uniswap v4's PoolManager, PancakeSwap Infinity's Vault and
// CLPoolManager, and the treasury Tessera pays out of, on Robinhood Chain only. A build for
// another chain compiles its own copy of this file in its place (chains/<name>/Chain.sol, chosen
// by VH_CHAIN in lib/hardhat.config.js). A chain without one of these keeps address(0) for it,
// and the registry lists no pool there.
//
// ALGEBRA is 1 when the build trades Algebra Integral pools (kind 3), else 0: VanHelsing tests V3
// and Algebra pools at once by their kind shifted right by it (2 and 3 differ in the last bit
// only), and leaves Algebra's reads out when it is 0. BNB Chain lists none, so its build tests
// kind 2 alone, as it did.
library Chain {
    address internal constant WRAPPED_NATIVE = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c; // WBNB
    address internal constant UNI_V4_POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    address internal constant INFINITY_VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address internal constant INFINITY_CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address internal constant TESSERA_TREASURY = address(0);
    uint8 internal constant ALGEBRA = 0;
}
