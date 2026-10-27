// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { RouteLib } from "../libraries/RouteLib.sol";
import { IPoolRegistry } from "../interfaces/IPoolRegistry.sol";

contract RouteLibHarness {
    function normalize(address reg, bytes32 routeId)
        external
        view
        returns (uint160 s, uint256 l, uint256 fn, uint256 fd)
    {
        return RouteLib.normalize(IPoolRegistry(reg), routeId);
    }

    function effectiveLiquidity(address reg, bytes32 routeId, uint160 defSqrtP, uint256 maxTicks)
        external
        view
        returns (uint256)
    {
        return RouteLib.effectiveLiquidity(IPoolRegistry(reg), routeId, defSqrtP, maxTicks);
    }
}
