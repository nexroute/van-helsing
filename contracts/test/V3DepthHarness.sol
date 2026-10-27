// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { V3Depth } from "../libraries/V3Depth.sol";

// Exposes V3Depth to the JS tests.
contract V3DepthHarness {
    function effectiveLiquidity(address pool, uint160 targetSqrtP, uint256 maxTicks)
        external
        view
        returns (uint128)
    {
        (uint128 l,) = V3Depth.effectiveLiquidity(pool, targetSqrtP, maxTicks);
        return l;
    }

    // The walk toward t2 on the pool, walked, and replayed from the record of the walk toward t1;
    // covered is false when the record does not cover it.
    function replayed(address pool, uint160 t1, uint160 t2, uint256 maxTicks)
        external
        view
        returns (uint128 walked, uint128 fromRecord, bool covered)
    {
        (, bytes memory r) = V3Depth.effectiveLiquidity(pool, t1, maxTicks);
        (walked,) = V3Depth.effectiveLiquidity(pool, t2, maxTicks);
        (fromRecord, covered) = V3Depth.replay(r, t2);
    }
}
