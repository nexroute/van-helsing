// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

interface IPoolRegistry {
    // A pool as the operator states it: its id, protocol kind, trade fee (over the kind's
    // precision: 1e4 V2 family, 1e6 V3 and the singletons, 1e10 stableswap), transfer taxes
    // and shape. This is what wardPools returns and VanHelsing carries in memory; it is not
    // what the ranked list persists. The list keeps just the ids, in order, and each
    // pool's kind, fee and tax live in its entry (their single home, and the only place a V2
    // fee can live: it is not reliably on-chain). Read them back with entryOf(id).
    //
    // The id is a bytes32: a pool contract's address zero-padded to 32 bytes (recovered
    // losslessly with address(uint160(uint256(id)))), a singleton pool's full poolId (the
    // keccak of its PoolKey, untruncated), or a route's own id. They never collide: a padded
    // address has 12 zero high bytes, and a hash effectively never does.
    //
    // `tax` is the share of each transfer between VanHelsing and the pool that a token taking
    // a fee on transfer loses, in basis points, packed high to low as
    //   taxIn0 | taxOut0 | taxIn1 | taxOut1      (16 bits each)
    // where In is VanHelsing -> the pool's custody (the pair, or the V4/Infinity singleton),
    // Out the reverse, and 0/1 the pair's sorted token0/token1. Zero is untaxed. It is per
    // pool because a token often taxes its AMM pair but not a singleton.
    //
    // `shape` is what reading a singleton pool takes beyond its id: its tick spacing in the
    // low 24 bits (an int24), and in bit 24 whether its currency0 is the native currency, which
    // a pair keys as WBNB. Zero for any other pool.
    struct Pool {
        bytes32 id;
        uint8 kind;
        uint32 fee;
        uint64 tax;
        uint32 shape;
    }

    // A singleton pool's config (see configOf) is a packed blob, never a struct: the V4/Infinity
    // adapters read the fields they need straight out of it in assembly (see V4Config for the
    // exact byte layout). The currencies it carries are the pool's own (native ==
    // address(0)), which can differ from the ERC20 token0/token1 the pair is keyed by.

    // Ranked pool ids for the pair, most-liquid first; callers browse in order and read
    // each pool's kind+fee+tax with entryOf.
    function poolsFor(address a, address b) external view returns (bytes32[] memory);

    function entryOf(bytes32 id)
        external
        view
        returns (uint8 kind, address token0, address token1, uint32 fee, uint64 tax, bool ok);

    // What a ward on the pool `id` reads, in one call: the pool's entry, and its anchor, the
    // first pool listed for its pair other than itself (a zero id when there is none, or when
    // the pool is not registered). The list is read only as far as the anchor, one or two
    // ids, however many pools it holds.
    function wardPools(bytes32 id)
        external
        view
        returns (Pool memory pool, address token0, address token1, bool ok, Pool memory anchor);

    // A singleton pool's config blob (the encoded PoolKey the swap needs), keyed by its id,
    // or a route's. A pool contract needs no config: its id is its address and its tokens and
    // fee live in the entry.
    function configOf(bytes32 id) external view returns (bytes memory);

    // One slot of the registry's storage (PoolRegistry lays it out), write's counterpart: how
    // VanHelsing reads a singleton pool's packed key.
    function read(uint256 slot) external view returns (uint256 value);

    // Two tokens' operator-set payout policies, each packed in one slot. `priority` ranks a
    // pair's tokens: the bounty is paid in the higher one when the trade allows it (a
    // stableswap sink or a taxed pair is paid exact-in); 0 == no preference. `minProfit` is the
    // dust floor in that token's own wei (0 == any profit). Unset reads (0, 0).
    function tokenInfos(address a, address b)
        external
        view
        returns (uint128 priorityA, uint128 minProfitA, uint128 priorityB, uint128 minProfitB);
}
