import { decodeEventLog, encodeFunctionData, toEventSelector } from "viem";

// ward(id, payee): VanHelsing restores the pool against the most liquid other pool its registry
// lists for the pair. The caller has no say in that anchor.
export const WARD_ABI = [
    {
        type: "function",
        name: "ward",
        inputs: [{ type: "bytes32", name: "id" }, { type: "address", name: "payee" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
];

// What VanHelsing logs when a ward closes a gap: the whole bounty, in `token`, of which
// `payee` was paid all but CUT_BPS.
export const CAPTURED_EVENT = {
    type: "event",
    name: "Captured",
    inputs: [
        { type: "bytes32", name: "pool", indexed: true },
        { type: "bytes32", name: "anchor", indexed: true },
        { type: "address", name: "payee", indexed: true },
        { type: "address", name: "token", indexed: false },
        { type: "uint256", name: "bounty", indexed: false },
    ],
};
const CAPTURED_TOPIC = toEventSelector(CAPTURED_EVENT).toLowerCase();

// VanHelsing's cut of every bounty, in basis points; the payee gets the rest.
export const CUT_BPS = 1000n;

const ZERO = "0x0000000000000000000000000000000000000000";

// The ward(id, payee) call for one pool: { to, data, id, kind }, addressed to VanHelsing.
// `payee` receives the bounty, less VanHelsing's cut; the zero address means whoever sends the
// call.
export function wardCall(pool, { vanHelsing, payee = ZERO }) {
    return {
        to: vanHelsing,
        data: encodeFunctionData({ abi: WARD_ABI, functionName: "ward", args: [pool.id, payee] }),
        id: pool.id,
        kind: pool.kind,
    };
}

// One VanHelsing ward(id, payee) call per identified pool. `vanHelsing` is the deployed
// contract address (required, there is no default). `payee` receives each bounty, less
// VanHelsing's 10% cut; left out, it is the zero address, which the contract reads as whoever
// sends the call. Sent through a contract such as Multicall3, that is the contract, so pass
// `payee` then. A ward on a pool VanHelsing cannot anchor is a safe no-op, so it is fine to
// emit a call for every pool a route touched.
export function buildWards(pools, { vanHelsing, payee = ZERO } = {}) {
    if (!vanHelsing) throw new Error("buildWards: vanHelsing address is required");
    return (pools || []).map((p) => wardCall(p, { vanHelsing, payee }));
}

// The bounty a ward logged, { token, amount, payee, anchor }, or null when it captured nothing.
export function readBounty(logs, vanHelsing) {
    const vh = vanHelsing.toLowerCase();
    for (const log of logs || []) {
        if ((log.address || "").toLowerCase() !== vh || (log.topics?.[0] || "").toLowerCase() !== CAPTURED_TOPIC) continue;
        const { args } = decodeEventLog({ abi: [CAPTURED_EVENT], data: log.data, topics: log.topics });
        return { token: args.token, amount: args.bounty, payee: args.payee, anchor: args.anchor };
    }
    return null;
}

// What the payee keeps of a bounty: all of it less VanHelsing's cut, rounded in the
// payee's favor as the contract does.
export function shareOf(amount) {
    return amount - (amount * CUT_BPS) / 10000n;
}
