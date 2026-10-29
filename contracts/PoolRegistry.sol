// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { IPoolRegistry } from "./interfaces/IPoolRegistry.sol";
import { Chain } from "./libraries/Chain.sol";

// Operator-curated pool registry. The operator keeps, per token pair, a ranked list of pools
// (most-liquid first) refreshed off-chain like an oracle, each entry stating its protocol
// kind, trade fee and transfer taxes directly. It writes the storage directly (write): the
// slots an update changes, computed off-chain. The layout is therefore part of the
// interface: keep the state variables, their order and their structs as they are. The owner
// only appoints the operator and hands ownership on, so a lost or leaked operator key is
// replaced in one call.
//
// A pool is keyed by a bytes32 id: a pool contract's address zero-padded to 32 bytes, or a
// singleton (V4/Infinity) pool's poolId; a route has an id of its own. Singleton pools have
// no address of their own, so the operator also stores each one's PoolKey, which the swap
// needs: packed in one word that configOf unpacks into the config blob the adapters read
// (see V4Config), the pool's tokens coming from its entry. A config that does not pack, and
// a route's, is kept as written.
//
// The list is a quality input, not a safety one, so the registry does no on-chain
// validation: VanHelsing is fundless, so even a leaked operator key that injects a hostile
// pool can at worst make a ward fail, waste gas, or capture less, never steal (every flash
// self-repays or the frame reverts) and never take down the caller's transaction (the ward
// swallows its own revert).
contract PoolRegistry is IPoolRegistry {
    // Two slots, both read for the pool warded. The second holds all a pool needs as an anchor:
    // kind, fee and shape (IPoolRegistry.Pool), with token1, ok and `taxed` (set when its tax is
    // not zero). So an untaxed anchor costs one read; a taxed one's first slot (token0, tax and
    // `first`, set on its pair's first ranked pool) is read too, for its tax.
    struct Entry {
        address token0;
        uint64 tax;
        bool first;
        address token1;
        uint32 fee;
        uint8 kind;
        bool ok;
        bool taxed;
        uint32 shape;
    }

    // Per-token payout policy, packed into one slot. priority ranks a pair's tokens
    // (higher = the token the bounty is paid in when the trade allows it; 0 = no preference);
    // minProfit is the dust floor in that token's own wei (0 = any profit). Unset reads
    // (0, 0).
    struct TokenInfo {
        uint128 priority;
        uint128 minProfit;
    }

    address public owner;
    address public operator;
    mapping(bytes32 => Entry) internal entries;
    // Ranked ids only (the ordering the entries can't hold); each pool's kind+fee+tax live in
    // its entry.
    mapping(bytes32 => bytes32[]) internal poolsByPair;
    mapping(address => TokenInfo) internal tokenInfo;
    mapping(bytes32 => bytes) internal poolConfig;
    // A singleton pool's PoolKey, packed: hooks in bits 0-159, the fee in 160-183, the tick
    // spacing in 184-207, whether currency0 is native at bit 208, and the low 40 bits of
    // Infinity's parameters (the rest are zero) in 216-255. Never zero: no tick spacing is.
    // Slot 6, where VanHelsing reads it (REG_POOL_KEYS).
    mapping(bytes32 => uint256) internal poolKeys;

    // The ERC20 a native currency stands for in a pair.
    address internal constant WRAPPED_NATIVE = Chain.WRAPPED_NATIVE;

    event OwnerChanged(address indexed owner);
    event OperatorChanged(address indexed operator);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "NOT_OPERATOR");
        _;
    }

    // The deployer starts as both owner and operator.
    constructor() {
        owner = msg.sender;
        operator = msg.sender;
        emit OwnerChanged(msg.sender);
        emit OperatorChanged(msg.sender);
    }

    // Hand ownership on. Never to the zero address: no one could appoint an operator again.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    // Appoint the key that writes; the zero address stops the writes. A stale ranking only
    // degrades capture, never safety.
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    // Store data's (slot, value) pairs, 64 bytes each. Slots 0 and 1 (owner and operator) are
    // refused, and so is data whose length is not a multiple of 64.
    function write(bytes calldata data) external onlyOperator {
        assembly ("memory-safe") {
            if mod(data.length, 64) { revert(0, 0) }
            for { let p := data.offset let end := add(p, data.length) } lt(p, end) { p := add(p, 64) } {
                let slot := calldataload(p)
                if lt(slot, 2) { revert(0, 0) }
                sstore(slot, calldataload(add(p, 32)))
            }
        }
    }

    function poolsFor(address a, address b) external view returns (bytes32[] memory) {
        return poolsByPair[_key(a, b)];
    }

    function entryOf(bytes32 id)
        external
        view
        returns (uint8 kind, address token0, address token1, uint32 fee, uint64 tax, bool ok)
    {
        Entry memory e = entries[id];
        return (e.kind, e.token0, e.token1, e.fee, e.tax, e.ok);
    }

    // Read and returned in assembly: every ward calls it. The pool's two entry slots are read
    // once each and its Pool written from them; its anchor's second slot is read, and its first
    // only when the anchor is taxed. The anchor is the list's first id other than the pool's
    // own: the second id for the pool marked `first`, the first id for any other, either one
    // checked against the pool's id, which catches a mark one place off. So the operator's
    // writes set `first` on the list's first pool alone, sort an entry's tokens as _key sorts
    // them, and give every listed id its entry (the anchor's ok is not read); a pool that is
    // not ok gets a zero anchor. The ids are read without the list's length: its slots past its
    // end are zero (a list that shrinks clears what it leaves, as Solidity does and the
    // operator's writes must), so a zero id is the end of the list.
    function wardPools(bytes32 id)
        external
        view
        returns (Pool memory, address, address, bool, Pool memory)
    {
        assembly ("memory-safe") {
            // A Pool, from its id and its entry's two slots: id, kind, fee, tax, shape.
            function _put(q, i, x, y) {
                mstore(q, i)
                mstore(add(q, 0x20), and(shr(192, y), 0xff))
                mstore(add(q, 0x40), and(shr(160, y), 0xffffffff))
                mstore(add(q, 0x60), and(shr(160, x), 0xffffffffffffffff))
                mstore(add(q, 0x80), and(shr(216, y), 0xffffffff))
            }

            let p := mload(0x40)
            mstore(0, id)
            mstore(0x20, entries.slot)
            let s := keccak256(0, 0x40)
            let a := sload(s)
            let b := sload(add(s, 1))
            let t0 := and(a, 0xffffffffffffffffffffffffffffffffffffffff)
            let t1 := and(b, 0xffffffffffffffffffffffffffffffffffffffff)
            let ok := iszero(iszero(and(shr(200, b), 0xff)))
            _put(p, id, a, b)
            mstore(add(p, 0xa0), t0)
            mstore(add(p, 0xc0), t1)
            mstore(add(p, 0xe0), ok)
            _put(add(p, 0x100), 0, 0, 0)
            if ok {
                mstore(0, shl(96, t0))
                mstore(0x14, shl(96, t1))
                mstore(0, keccak256(0, 0x28))
                mstore(0x20, poolsByPair.slot)
                mstore(0, keccak256(0, 0x40))
                let at := keccak256(0, 0x20)
                let other
                switch and(shr(224, a), 0xff)
                case 0 {
                    other := sload(at)
                    if eq(other, id) { other := sload(add(at, 1)) }
                }
                default {
                    other := sload(add(at, 1))
                    if eq(other, id) { other := sload(at) }
                }
                if other {
                    mstore(0, other)
                    mstore(0x20, entries.slot)
                    s := keccak256(0, 0x40)
                    b := sload(add(s, 1))
                    a := 0
                    if and(shr(208, b), 0xff) { a := sload(s) } // a taxed anchor's tax
                    _put(add(p, 0x100), other, a, b)
                }
            }
            return(p, 0x1a0)
        }
    }

    // An entry's two slots, read once each.
    function _slots(bytes32 id) private view returns (uint256 a, uint256 b) {
        assembly ("memory-safe") {
            mstore(0, id)
            mstore(0x20, entries.slot)
            let s := keccak256(0, 0x40)
            a := sload(s)
            b := sload(add(s, 1))
        }
    }

    // A singleton pool's config blob, unpacked from its key word (poolKeys) with its kind and
    // tokens from its entry: a native currency0 is address(0), its currency1 the pair's other
    // token. Any other id gets its poolConfig bytes as written (empty when unset). VanHelsing
    // unpacks the word the same way (_cfg).
    function configOf(bytes32 id) external view returns (bytes memory) {
        uint256 w = poolKeys[id];
        if (w == 0) return poolConfig[id];
        (uint256 a, uint256 b) = _slots(id);
        (address t0, address t1) = (address(uint160(a)), address(uint160(b)));
        (address c0, address c1) = uint8(w >> 208) & 1 != 0 ? (address(0), t0 == WRAPPED_NATIVE ? t1 : t0) : (t0, t1);
        return abi.encodePacked(uint8(b >> 192), c0, c1, uint24(w >> 160), uint24(w >> 184), address(uint160(w)), bytes32(w >> 216));
    }

    // One slot of the registry's storage, as laid out above: write's counterpart. VanHelsing
    // reads a singleton pool's key word (poolKeys) this way and unpacks the config itself, as
    // configOf does, with the kind and tokens wardPools already gave it. The slot is a uint256
    // for the selector: read(bytes32)'s or extsload(bytes32)'s would make the dispatcher take a
    // step more to find tokenInfos or wardPools, 22 gas on every capture or on every ward.
    function read(uint256 slot) external view returns (uint256 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    // Both tokens' payout policies in one call.
    function tokenInfos(address a, address b)
        external
        view
        returns (uint128 priorityA, uint128 minProfitA, uint128 priorityB, uint128 minProfitB)
    {
        (TokenInfo storage x, TokenInfo storage y) = (tokenInfo[a], tokenInfo[b]);
        return (x.priority, x.minProfit, y.priority, y.minProfit);
    }

    function _key(address a, address b) internal pure returns (bytes32) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(lo, hi));
    }
}
