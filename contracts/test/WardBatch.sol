// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { IWard } from "../interfaces/IWard.sol";

// Wards several pools in one transaction, in order, as a router does around a swap: the wards
// share the transaction's transient storage.
contract WardBatch {
    function wards(IWard vh, bytes32[] calldata ids, address payee) external {
        for (uint256 i; i < ids.length; i++) vh.ward(ids[i], payee);
    }
}
