import { ethers } from "ethers";

// Pancake Infinity CLPoolManager (BSC), part of a Pancake pool's poolId hash.
const CL = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b";
const coder = ethers.AbiCoder.defaultAbiCoder();

// bytes32 id for a V2/V3/stableswap pool: its address zero-padded to 32 bytes
// (lowercased so it compares equal to what the contract returns).
export const idAddr = (addr) => ethers.zeroPadValue(addr, 32).toLowerCase();

// poolId (bytes32) for a singleton pool. meta = [kind, c0, c1, fee, tickSpacing, hooks, params].
export function idV4(meta) {
    const [kind, c0, c1, fee, ts, hooks, params] = meta;
    return kind === 4
        ? ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, ts, hooks]))
        : ethers.keccak256(coder.encode(["address", "address", "address", "address", "uint24", "bytes32"], [c0, c1, hooks, CL, fee, params]));
}

// The packed config blob the adapters read field-by-field in assembly (see V4Config).
// meta = [kind, c0, c1, fee, tickSpacing, hooks, params], laid out with no abi headers.
export const configV4 = (meta) =>
    ethers.solidityPacked(["uint8", "address", "address", "uint24", "int24", "address", "bytes32"], meta);

// Store a singleton pool's config and return its id.
export async function registerV4(registry, meta) {
    const id = idV4(meta);
    await registry.setConfig(id, configV4(meta));
    return id;
}

// Route kind (VanHelsing's own, numbered apart from the protocol kinds).
export const ROUTE = 200;

// bytes32 id for a 2-hop route: keccak of its two hop ids.
export const idRoute = (hop1Id, hop2Id) =>
    ethers.keccak256(coder.encode(["bytes32", "bytes32"], [hop1Id, hop2Id]));

// The packed route config: [kind(1) | hop1(32) | hop2(32) | mid(20)].
export const configRoute = (hop1Id, hop2Id, mid) =>
    ethers.solidityPacked(["uint8", "bytes32", "bytes32", "address"], [ROUTE, hop1Id, hop2Id, mid]);
