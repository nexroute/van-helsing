// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { V3Depth } from "../libraries/V3Depth.sol";
import { DepthRecord } from "../libraries/DepthRecord.sol";

// Exposes V3Depth to the JS tests.
contract V3DepthHarness {
    function effectiveLiquidity(address pool, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128)
    {
        (uint128 l,) = V3Depth.effectiveLiquidity(pool, targetSqrtP, maxTicks, false);
        return l;
    }

    // Where the walk toward targetSqrtP ran dry, as its record keeps it (0 when it did not).
    function cliffOf(address pool, uint160 targetSqrtP, uint256 maxTicks) external view returns (uint160) {
        (, bytes memory r) = V3Depth.effectiveLiquidity(pool, targetSqrtP, maxTicks, false);
        return DepthRecord.cliffOf(r);
    }

    // The walk of a pool a ward sinks into: the way past its last liquidity counts at zero.
    function effectiveLiquidityDry(address pool, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128)
    {
        (uint128 l,) = V3Depth.effectiveLiquidity(pool, targetSqrtP, maxTicks, true);
        return l;
    }

    // The walk toward t2 on the pool, walked, and replayed from the record of the walk toward t1;
    // covered is false when the record does not cover it.
    function replayed(address pool, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        return _replayed(pool, t1, t2, maxTicks, false);
    }

    // The same, for dry walks.
    function replayedDry(address pool, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        return _replayed(pool, t1, t2, maxTicks, true);
    }

    function _replayed(address pool, uint160 t1, uint160 t2, uint256 maxTicks, bool dry)
        private
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        (, bytes memory r) = V3Depth.effectiveLiquidity(pool, t1, maxTicks, dry);
        (walked,) = V3Depth.effectiveLiquidity(pool, t2, maxTicks, dry);
        (fromRecord, covered) = V3Depth.replay(r, t2);
    }

    // The same two, on an Algebra Integral pool's linked ticks.
    function effectiveLiquidityList(address pool, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128)
    {
        (uint128 l,) = V3Depth.effectiveLiquidityList(pool, targetSqrtP, maxTicks, false);
        return l;
    }

    // Where the list walk toward targetSqrtP ran dry, as its record keeps it (0 when it did not).
    function cliffOfList(address pool, uint160 targetSqrtP, uint256 maxTicks) external view returns (uint160) {
        (, bytes memory r) = V3Depth.effectiveLiquidityList(pool, targetSqrtP, maxTicks, false);
        return DepthRecord.cliffOf(r);
    }

    function replayedList(address pool, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        return _replayedList(pool, t1, t2, maxTicks, false);
    }

    function effectiveLiquidityListDry(address pool, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128 l)
    {
        (l,) = V3Depth.effectiveLiquidityList(pool, targetSqrtP, maxTicks, true);
    }

    function replayedListDry(address pool, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        return _replayedList(pool, t1, t2, maxTicks, true);
    }

    function _replayedList(address pool, uint160 t1, uint160 t2, uint256 maxTicks, bool dry)
        private
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        (, bytes memory r) = V3Depth.effectiveLiquidityList(pool, t1, maxTicks, dry);
        (walked,) = V3Depth.effectiveLiquidityList(pool, t2, maxTicks, dry);
        (fromRecord, covered) = V3Depth.replay(r, t2);
    }
}
