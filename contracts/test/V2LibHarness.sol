// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { V2Lib } from "../libraries/V2Lib.sol";

contract V2LibHarness {
    function driveAmount(uint256 r0, uint256 r1, uint256 fn, uint256 fd, uint160 targetSqrtP, bool zeroForOne)
        external
        pure
        returns (uint256)
    {
        return V2Lib.driveAmount(r0, r1, fn, fd, targetSqrtP, zeroForOne);
    }

    function amountOut(uint256 amtIn, uint256 rIn, uint256 rOut, uint256 fn, uint256 fd)
        external
        pure
        returns (uint256)
    {
        return V2Lib.amountOut(amtIn, rIn, rOut, fn, fd);
    }
}
