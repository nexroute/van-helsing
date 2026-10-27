import { pad } from "viem";
import { TOPICS } from "./topics.js";

// Parse simulated Swap logs into the distinct pool ids a route touched. A V2/V3/Curve
// pool's id is its own address zero-padded to bytes32; a V4/Infinity singleton pool's
// id is its poolId (topic1). No network access. Deduped by id, order preserved.
export function identifyPoolIds(logs) {
    const seen = new Set();
    const out = [];
    for (const log of logs || []) {
        const t0 = (log.topics?.[0] || "").toLowerCase();
        const entry = TOPICS[t0];
        if (!entry) continue;
        const id = entry.singleton
            ? (log.topics[1] || "").toLowerCase()
            : pad(log.address.toLowerCase(), { size: 32 });
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ kind: entry.kind, id });
    }
    return out;
}
