// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { MeetingPrice } from "../libraries/MeetingPrice.sol";

contract MeetingPriceHarness {
    // named `meet` (not `target`) so it does not collide with ethers v6's
    // Contract.target address property in the tests.
    function meet(uint160 sd, uint256 ld, uint160 sa, uint256 la) external pure returns (uint160) {
        return MeetingPrice.target(sd, ld, sa, la);
    }

    function meetFee(uint160 sd, uint256 ld, uint256 nd, uint256 dd, uint160 sa, uint256 la, uint256 na, uint256 da)
        external
        pure
        returns (uint160)
    {
        return MeetingPrice.targetFee(sd, ld, nd, dd, sa, la, na, da);
    }

    function meetBoth(uint160 sd, uint256 ld, uint256 nd, uint256 dd, uint160 sa, uint256 la, uint256 na, uint256 da)
        external
        pure
        returns (uint160 sdFinal, uint160 saFinal)
    {
        return MeetingPrice.meet(sd, ld, nd, dd, sa, la, na, da);
    }

    function noArb(uint160 sd, uint256 nd, uint256 dd, uint160 sa, uint256 na, uint256 da) external pure returns (bool) {
        return MeetingPrice.noArb(sd, nd, dd, sa, na, da);
    }
}
