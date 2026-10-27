// Canonical VanHelsing deployments, keyed by chainId. Once populated, consumers get
// the right address for free via planWards(): no need to pass one. Filled in on each
// on-chain deployment; a single line per chain.
//
// planWards() resolves from here by the client's chainId, or takes an explicit
// { vanHelsing } override; on a chain with neither it throws a clear error naming the chain.
//
// Van Helsing's node reads the same address, to count what the contract captures (its
// geth/vanhelsing/onchain.go, in the development repository): add it there too. It is the
// proxy's address (ignition/modules/VanHelsing.js), which upgrades leave as it is.
export const VANHELSING = {
    56: "0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25", // BNB Chain
};

// The deployed VanHelsing address for a chain, or undefined if none is known here.
export function vanHelsingFor(chainId) {
    return VANHELSING[chainId];
}
