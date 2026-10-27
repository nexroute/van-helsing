// A suite that reads BNB Chain's own state runs on a fork of it: BSC_ARCHIVE_URL, or the public
// Blast archive by default. VH_NO_FORK=1 turns the fork off and skips these suites, so the rest
// runs alone and fast, as CI runs it.
export const describeFork = process.env.VH_NO_FORK ? describe.skip : describe;
