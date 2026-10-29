// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { CurveLib } from "../libraries/CurveLib.sol";

contract CurveLibHarness {
    // The price and the uncapped depth at that price, as a ward reads them.
    function normalize(uint8 kind, address pool, address t0, address t1) external view returns (uint160 s, uint256 l) {
        s = CurveLib.price(kind, pool, t0);
        l = CurveLib.depth(kind, pool, t0, t1, s, s);
    }

    function balances(address pool, address t0, address) external view returns (uint256 b0, uint256 b1) {
        return CurveLib.balances(pool, t0);
    }

    // A market's leg as a ward reads it: its mid, and the fee multiplier its bid and ask make.
    function marketPrice(uint8 kind, address pool, address t0, address t1)
        external
        view
        returns (uint160 s, uint256 fn, uint256 fd)
    {
        return CurveLib.marketPrice(kind, pool, t0, t1);
    }

    function depth(uint8 kind, address pool, address t0, address t1, uint160 sOwn, uint160 sOther)
        external
        view
        returns (uint256)
    {
        return CurveLib.depth(kind, pool, t0, t1, sOwn, sOther);
    }
}
