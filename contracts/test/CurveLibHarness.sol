// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { CurveLib } from "../libraries/CurveLib.sol";

contract CurveLibHarness {
    // The price and the uncapped depth at that price, as a ward reads them.
    function normalize(uint8 kind, address pool, address t0, address) external view returns (uint160 s, uint256 l) {
        s = CurveLib.price(kind, pool, t0);
        l = CurveLib.depth(kind, pool, t0, s, s);
    }

    function balances(address pool, address t0, address) external view returns (uint256 b0, uint256 b1) {
        return CurveLib.balances(pool, t0);
    }
}
