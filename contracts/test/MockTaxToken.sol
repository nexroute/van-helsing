// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

// Mintable 18-dec ERC20 that takes a fee on transfer the way launchpad tokens tax their
// AMM pair: `buyBps` of a transfer FROM a taxed address and `sellBps` of a transfer TO
// one are burned, floored like `amount * bps / 1e4`. Other transfers are free, so a test
// can tax a V2 pair while leaving a singleton or another pool untaxed.
contract MockTaxToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint16) public buyBps;
    mapping(address => uint16) public sellBps;

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function setTax(address who, uint16 buy, uint16 sell) external {
        buyBps[who] = buy;
        sellBps[who] = sell;
    }

    function mint(address to, uint256 amt) external {
        totalSupply += amt;
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        _move(from, to, amt);
        return true;
    }

    function _move(address from, address to, uint256 amt) private {
        uint256 fee = amt * (uint256(buyBps[from]) + sellBps[to]) / 1e4;
        balanceOf[from] -= amt;
        balanceOf[to] += amt - fee;
        totalSupply -= fee;
    }
}
