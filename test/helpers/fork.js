// A suite that reads BNB Chain's own state runs on a fork of it: BSC_ARCHIVE_URL, or the public
// Blast archive by default. VH_NO_FORK=1 turns the fork off and skips these suites, so the rest
// runs alone and fast, as CI runs it.
// A build for another chain (VH_CHAIN) skips them too: its contracts carry that chain's addresses.
export const describeFork = process.env.VH_NO_FORK || (process.env.VH_CHAIN || "bnb") !== "bnb" ? describe.skip : describe;

// A suite that reads Robinhood Chain's state runs on the Robinhood build alone
// (VH_CHAIN=robinhood), whose default network forks Robinhood Chain.
export const describeRobinhood = process.env.VH_CHAIN === "robinhood" && !process.env.VH_NO_FORK ? describe : describe.skip;

// A suite of the Robinhood build that needs no fork: mocks placed at the addresses its Chain.sol
// names. CI runs it (VH_CHAIN=robinhood VH_NO_FORK=1).
export const describeRobinhoodBuild = process.env.VH_CHAIN === "robinhood" ? describe : describe.skip;
