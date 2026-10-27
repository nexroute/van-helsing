import { ethers as ethersLib } from "ethers";

// Shared fork-tick readers for concentrated pools (V3-shaped pool contracts and V4
// singleton pools), so any fork test can build a real `concModel(...)` leg from live
// chain state without re-implementing a tick reader. Pure reads (no chain state
// mutation). measure-conc.test.js and exec-matrix.test.js both import from here.

// Uniswap V4 PoolManager (BSC): the extsload reads below go to its storage.
const POOL_MANAGER = "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF";

// Read initialized ticks in [tickLo, tickHi] from a Uniswap-V3-shaped pool. Scans the
// spacing-compressed bitmap word by word, then reads each set tick's liquidityNet.
export async function readV3Ticks(provider, poolAddr, spacing, tickLo, tickHi) {
    const abi = [
        "function tickBitmap(int16) view returns (uint256)",
        "function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 fg0, uint256 fg1, int56 tc, uint160 spl, uint32 so, bool init)",
    ];
    const pool = new ethersLib.Contract(poolAddr, abi, provider);
    const cLo = Math.floor(tickLo / spacing), cHi = Math.floor(tickHi / spacing);
    const wLo = cLo >> 8, wHi = cHi >> 8;
    const ticks = [];
    for (let w = wLo; w <= wHi; w++) {
        const word = BigInt(await pool.tickBitmap(w));
        if (word === 0n) continue;
        for (let b = 0n; b < 256n; b++) {
            if (((word >> b) & 1n) === 0n) continue;
            const comp = (w << 8) + Number(b);
            if (comp < cLo || comp > cHi) continue;
            const tick = comp * spacing;
            const [, liquidityNet] = await pool.ticks(tick);
            ticks.push({ tick, liqNet: liquidityNet });
        }
    }
    return ticks;
}

// Read initialized ticks in [tickLo, tickHi] from a Uniswap-V4 pool via StateLibrary
// extsload on the PoolManager (the same slot math V4Depth reads through the getters).
export async function readV4Ticks(provider, poolId, spacing, tickLo, tickHi) {
    const pm = new ethersLib.Contract(POOL_MANAGER, ["function extsload(bytes32) view returns (bytes32)"], provider);
    const stateSlot = BigInt(ethersLib.keccak256(ethersLib.solidityPacked(["bytes32", "bytes32"], [poolId, ethersLib.zeroPadValue("0x06", 32)])));
    const bitmapBase = stateSlot + 5n, ticksBase = stateSlot + 4n;
    const cLo = Math.floor(tickLo / spacing), cHi = Math.floor(tickHi / spacing);
    const wLo = cLo >> 8, wHi = cHi >> 8;
    const ticks = [];
    for (let w = wLo; w <= wHi; w++) {
        const slot = ethersLib.keccak256(ethersLib.solidityPacked(["int256", "uint256"], [w, bitmapBase]));
        const word = BigInt(await pm.extsload(slot));
        if (word === 0n) continue;
        for (let b = 0n; b < 256n; b++) {
            if (((word >> b) & 1n) === 0n) continue;
            const comp = (w << 8) + Number(b);
            if (comp < cLo || comp > cHi) continue;
            const tick = comp * spacing;
            const tslot = ethersLib.keccak256(ethersLib.solidityPacked(["int256", "uint256"], [tick, ticksBase]));
            const raw = BigInt(await pm.extsload(tslot));
            let net = raw >> 128n; // liquidityNet = sar(128, word)
            if (net >= (1n << 127n)) net -= 1n << 128n;
            ticks.push({ tick, liqNet: net });
        }
    }
    return ticks;
}

export async function readV4Slot0Liq(provider, poolId) {
    const pm = new ethersLib.Contract(POOL_MANAGER, ["function extsload(bytes32) view returns (bytes32)"], provider);
    const stateSlot = BigInt(ethersLib.keccak256(ethersLib.solidityPacked(["bytes32", "bytes32"], [poolId, ethersLib.zeroPadValue("0x06", 32)])));
    const raw = BigInt(await pm.extsload("0x" + stateSlot.toString(16).padStart(64, "0")));
    const sqrtP = raw & ((1n << 160n) - 1n);
    let tick = (raw >> 160n) & ((1n << 24n) - 1n);
    if (tick >= 1n << 23n) tick -= 1n << 24n;
    const liq = BigInt(await pm.extsload("0x" + (stateSlot + 3n).toString(16).padStart(64, "0"))) & ((1n << 128n) - 1n);
    return { sqrtP, tick: Number(tick), liq };
}

// The ticks the drive actually crosses: INITIALIZED ticks strictly between the pool's
// spot tick and the drive's target tick. The tick reads above are scanned over a band
// padded well past the target (a margin, so the swap-to-target never runs off the edge of
// what was loaded); counting that whole band, margin included, would count ticks the
// drive never reaches as if they were crossed. Exclusive of both endpoints: a tick sitting
// exactly at spot or at the target is not something the restore swaps across.
export function crossedTicks(ticks, spotTick, targetTick) {
    const lo = Math.min(spotTick, targetTick), hi = Math.max(spotTick, targetTick);
    return ticks.filter((t) => t.tick > lo && t.tick < hi).length;
}
