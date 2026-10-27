// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

// What a caller needs of VanHelsing: ward(id, payee), which never reverts its caller and restores
// the pool `id` against its anchor, the first other pool the registry lists for its pair
// (VanHelsing.ward). ward(id, payee, maxGas) does the same with the attempt held to maxGas.
interface IWard {
    function ward(bytes32 id, address payee) external;
    function ward(bytes32 id, address payee, uint256 maxGas) external;
}
