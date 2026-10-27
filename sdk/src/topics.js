// The Swap events a pool emits, by topic0 (lowercase) -> { kind, singleton }, as Van Helsing's
// node reads them. `singleton` pools (V4/Infinity) live in one manager and carry their poolId
// in topic1; everything else is a pool whose own address is the id.
export const V4_MANAGER = "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df";
export const INFINITY_MANAGER = "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b";

export const TOPICS = {
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": { kind: 0, singleton: false }, // V2
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": { kind: 2, singleton: false }, // Uniswap V3
    "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83": { kind: 2, singleton: false }, // Pancake V3
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f": { kind: 4, singleton: true },  // Uniswap V4
    "0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237": { kind: 6, singleton: true },  // Pancake Infinity CL
    "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140": { kind: 5, singleton: false }, // Curve TokenExchange (sink-only; a ward no-ops)
};
