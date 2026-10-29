// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { PoolRegistry } from "../PoolRegistry.sol";

// The registry with typed writers, for the tests: they fill it through these, where the
// deployed registry's operator writes its storage directly (write).
contract PoolRegistryHarness is PoolRegistry {
    // A pool as the tests list it: its shape comes from its config (setConfig).
    struct Listed {
        bytes32 id;
        uint8 kind;
        uint32 fee;
        uint64 tax;
    }

    // Each singleton pool's shape, from its config, for the lists stored after it.
    mapping(bytes32 => uint32) private shapes;

    // Replace the ranked pool list for (a, b): the previous list and its entries go, then the
    // new pools are stored in order, each with its entry, the first one marked first. Each
    // entry's token0 and token1 are the pair's tokens, sorted.
    function setPools(address a, address b, Listed[] calldata pools) external onlyOperator {
        bytes32 key = _key(a, b);
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        bytes32[] storage prev = poolsByPair[key];
        for (uint256 i = 0; i < prev.length; ++i) {
            delete entries[prev[i]];
        }
        delete poolsByPair[key];
        for (uint256 i = 0; i < pools.length; ++i) {
            Listed calldata p = pools[i];
            poolsByPair[key].push(p.id);
            entries[p.id] = Entry({
                token0: lo,
                tax: p.tax,
                first: i == 0,
                token1: hi,
                fee: p.fee,
                kind: p.kind,
                ok: true,
                taxed: p.tax != 0,
                shape: shapes[p.id]
            });
        }
    }

    // A pool's config: a V4/Infinity config packed in its key word when it packs, else the
    // bytes as given; and the pool's shape, on its entry when it is listed.
    function setConfig(bytes32 id, bytes calldata config) external onlyOperator {
        (uint256 w, uint32 shape) = _pack(config);
        if (w != 0) {
            poolKeys[id] = w;
            delete poolConfig[id];
        } else {
            poolConfig[id] = config;
            delete poolKeys[id];
        }
        shapes[id] = shape;
        if (entries[id].ok) entries[id].shape = shape;
    }

    function setToken(address token, uint128 priority, uint128 minProfit) external onlyOperator {
        tokenInfo[token] = TokenInfo(priority, minProfit);
    }

    // A V4/Infinity config's key word (PoolRegistry.poolKeys), zero when it does not pack, and
    // its pool's shape (IPoolRegistry.Pool). It packs when configOf can give it back from the
    // word and the pool's entry: a Uniswap V4 pool's parameters are zero and an Infinity
    // pool's fit 40 bits, and a native pool's other currency is not the wrapped native one.
    function _pack(bytes calldata c) private pure returns (uint256 w, uint32 shape) {
        if (c.length != 99 || (c[0] != bytes1(0x04) && c[0] != bytes1(0x06))) return (0, 0);
        bool native = bytes20(c[1:21]) == bytes20(0);
        uint256 ts = uint24(bytes3(c[44:47]));
        uint256 params = uint256(bytes32(c[67:99]));
        shape = uint32(ts) | (native ? uint32(1 << 24) : 0);
        bool packs = (c[0] == bytes1(0x04) ? params == 0 : params >> 40 == 0)
            && !(native && address(bytes20(c[21:41])) == WRAPPED_NATIVE);
        if (!packs) return (0, shape);
        w = uint256(uint160(bytes20(c[47:67]))) | uint256(uint24(bytes3(c[41:44]))) << 160 | ts << 184
            | (native ? uint256(1) << 208 : 0) | params << 216;
    }
}
