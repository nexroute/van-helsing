// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { V4Depth } from "../libraries/V4Depth.sol";
import { V4Config } from "../libraries/V4Config.sol";
import { UniV4Lib } from "../libraries/UniV4Lib.sol";
import { InfinityLib } from "../libraries/InfinityLib.sol";
import { PoolId as UniPoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolId as InfiPoolId } from "@pancakeswap/v4-core/src/types/PoolId.sol";

contract V4DepthHarness {
    // The walk of the pool a config describes, read by its poolId as a ward reads it.
    function effectiveLiquidity(bytes calldata cfg, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128)
    {
        bytes memory c = cfg;
        uint8 kind = V4Config.kind(c);
        bytes32 id = kind == 4 ? UniPoolId.unwrap(UniV4Lib.poolId(c)) : InfiPoolId.unwrap(InfinityLib.poolId(c));
        (uint128 l,) = V4Depth.effectiveLiquidity(kind, id, V4Config.tickSpacing(c), !V4Config.aligned(c), targetSqrtP, maxTicks);
        return l;
    }

    // The walk toward t2, walked, and replayed from the record of the walk toward t1; covered is
    // false when the record does not cover it.
    function replayed(bytes calldata cfg, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        Pool memory p = _pool(cfg);
        (, bytes memory r) = V4Depth.effectiveLiquidity(p.kind, p.id, p.spacing, p.flipped, t1, maxTicks);
        (walked,) = V4Depth.effectiveLiquidity(p.kind, p.id, p.spacing, p.flipped, t2, maxTicks);
        (fromRecord, covered) = V4Depth.replay(r, t2);
    }

    struct Pool {
        uint8 kind;
        bytes32 id;
        int24 spacing;
        bool flipped;
    }

    function _pool(bytes calldata cfg) private pure returns (Pool memory p) {
        bytes memory c = cfg;
        p.kind = V4Config.kind(c);
        p.id = p.kind == 4 ? UniPoolId.unwrap(UniV4Lib.poolId(c)) : InfiPoolId.unwrap(InfinityLib.poolId(c));
        (p.spacing, p.flipped) = (V4Config.tickSpacing(c), !V4Config.aligned(c));
    }
}
