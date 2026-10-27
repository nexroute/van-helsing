// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

// Minimal Curve-shaped pool for the tests: two coins and their balances set at construction,
// a 1:1 get_dy quote, and an exchange that pays that quote, or half of it once setPayShort is
// on.
interface IERC20Coin {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract MockCurvePool {
    address[2] private _coins;
    uint256[2] private _balances;
    bool private payShort;

    constructor(address c0, address c1, uint256 b0, uint256 b1) {
        _coins = [c0, c1];
        _balances = [b0, b1];
    }

    function coins(uint256 i) external view returns (address) {
        return _coins[i];
    }

    function balances(uint256 i) external view returns (uint256) {
        return _balances[i];
    }

    // A Curve fee, in 1e10 units: 0.04%.
    function fee() external pure returns (uint256) {
        return 4_000_000;
    }

    // Unit-test quote: 1:1 (stablecoin peg), independent of the imbalanced balances,
    // so a test can prove normalize prices off get_dy and not the balances ratio.
    function get_dy(uint256, uint256, uint256 dx) external pure returns (uint256) {
        return dx;
    }

    // Swaps dx of coin i for its get_dy quote of coin j, or half of it once setPayShort is on:
    // a pool that pays less than it quotes, which the node's pool check must refuse.
    function exchange(uint256 i, uint256 j, uint256 dx, uint256) external returns (uint256 dy) {
        dy = payShort ? dx / 2 : dx;
        IERC20Coin(_coins[i]).transferFrom(msg.sender, address(this), dx);
        IERC20Coin(_coins[j]).transfer(msg.sender, dy);
        _balances[i] += dx;
        _balances[j] -= dy;
    }

    function setPayShort(bool v) external {
        payShort = v;
    }
}
