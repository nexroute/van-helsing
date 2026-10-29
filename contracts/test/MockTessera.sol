// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

interface IERC20Tessera {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

// The treasury Tessera pays out of, for the tests: placed at the address the build's Chain.sol names
// (setCode runs no constructor, so the entry it serves is set after).
contract MockTesseraTreasury {
    address public entry;

    function setEntry(address entry_) external {
        entry = entry_;
    }

    function pay(address token, address to, uint256 amount) external {
        require(msg.sender == entry, "ONLY_ENTRY");
        IERC20Tessera(token).transfer(to, amount);
    }
}

// Tessera's entry for the tests: one contract that prices every pair, as the venue does on Robinhood
// Chain, at a rate set per direction (output per input, 1e18 scaled). Its view quote ignores the
// treasury's balance, as the venue's does, and a refused pair quotes nothing. A swap pays the
// recipient out of the treasury first, then pulls the input into it with the caller's allowance.
contract MockTessera {
    MockTesseraTreasury private immutable treasury;
    mapping(address => mapping(address => uint256)) private rate;
    bool public refuse;

    constructor(MockTesseraTreasury treasury_) {
        treasury = treasury_;
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external {
        rate[tokenIn][tokenOut] = rate_;
    }

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
        public
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        require(amountSpecified > 0, "EXACT_IN");
        if (refuse || rate[tokenIn][tokenOut] == 0) return (0, 0);
        amountIn = uint256(amountSpecified);
        amountOut = amountIn * rate[tokenIn][tokenOut] / 1e18;
    }

    function tesseraSwapWithAllowances(
        address tokenIn,
        address tokenOut,
        int256 amountSpecified,
        uint256 amountCheck,
        address recipient,
        bytes calldata
    ) external {
        (uint256 amountIn, uint256 amountOut) = tesseraSwapViewAmounts(tokenIn, tokenOut, amountSpecified);
        require(amountOut != 0 && amountOut >= amountCheck, "AMOUNT_CHECK");
        treasury.pay(tokenOut, recipient, amountOut);
        IERC20Tessera(tokenIn).transferFrom(msg.sender, address(treasury), amountIn);
    }
}
