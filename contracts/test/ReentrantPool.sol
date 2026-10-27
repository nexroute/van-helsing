// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";

interface IVanHelsing {
    function execute(bytes32 id, address payee) external;
}

using SafeTransferLib for address;

// Malicious registered pool for the reentrancy safety test.
//
// It presents as a V2 USDT/WBNB pair (token0/token1/getReserves): registered as a V2 pool and
// warded, it is the pool VanHelsing flash-drives. When VanHelsing calls swap() during that
// flash, this pool re-enters execute(): the transient
// reentrancy lock MUST revert the nested call. We record that it reverted with "REENTRANCY", then
// short-circuit the flash by gifting VanHelsing a fixed amount of the profit
// token directly (no callback, no repayment). That makes the OUTER execute()
// commit, so the recorded flag survives the transaction and the test can read it.
//
// The flag is set only when the nested call reverts with exactly "REENTRANCY",
// which is produced solely by the lock. Remove the lock and the nested execute()
// never yields that reason (it recurses and reverts for other reasons, or the
// whole frame unwinds), so the flag stays false. That asymmetry is what lets the
// mutation check tell the guard present from the guard absent.
contract ReentrantPool {
    address public immutable TARGET; // VanHelsing
    address public immutable T0; // token0 (USDT)
    address public immutable T1; // token1 (WBNB)
    uint112 private immutable R0; // reported reserve0
    uint112 private immutable R1; // reported reserve1
    uint256 public immutable GIFT; // profit token handed back so execute() commits

    bool public reentryBlocked;

    constructor(address target, address t0, address t1, uint112 r0, uint112 r1, uint256 gift) {
        TARGET = target;
        T0 = t0;
        T1 = t1;
        R0 = r0;
        R1 = r1;
        GIFT = gift;
    }

    function token0() external view returns (address) {
        return T0;
    }

    function token1() external view returns (address) {
        return T1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (R0, R1, 0);
    }

    // Reached as the flash source of VanHelsing's arb (V2Lib.flash calls the pair's
    // swap). Re-enter execute() while the outer execute() holds the lock,
    // record that the lock reverted it, then gift the profit token so the outer
    // arb can commit instead of rolling the flag back.
    function swap(uint256, uint256, address to, bytes calldata) external {
        try IVanHelsing(TARGET).execute(bytes32(uint256(uint160(address(this)))), address(this)) {
            // nested execute() did not revert: the lock is absent (mutation).
        } catch Error(string memory reason) {
            if (keccak256(bytes(reason)) == keccak256(bytes("REENTRANCY"))) {
                reentryBlocked = true;
            }
        } catch {
            // low-level revert (e.g. OOG from unguarded recursion): leave false.
        }
        T0.safeTransfer(to, GIFT);
    }
}
