// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

// Packed config for a 2-hop route, stored opaque in the registry and read field by
// field in assembly (no abi.decode), as V4Config is. Layout (85 bytes):
//
//   [ 0]  uint8   kind    (== ROUTE, 200)
//   [ 1]  bytes32 hop1    (registry id of the (token0, mid) pool)
//   [33]  bytes32 hop2    (registry id of the (mid, token1) pool)
//   [65]  address mid     (the bridge token B)
//
// Convention: hop1 connects the pair's (token0, mid); hop2 connects (mid, token1).
// token0/token1 are the pair's sorted tokens, read from the route's own registry entry
// (entryOf(routeId)).
library RouteConfig {
    function hop1(bytes memory cfg) internal pure returns (bytes32 v) {
        assembly ("memory-safe") { v := mload(add(cfg, 0x21)) }
    }

    function hop2(bytes memory cfg) internal pure returns (bytes32 v) {
        assembly ("memory-safe") { v := mload(add(cfg, 0x41)) }
    }

    function mid(bytes memory cfg) internal pure returns (address v) {
        assembly ("memory-safe") { v := shr(96, mload(add(cfg, 0x61))) }
    }
}
