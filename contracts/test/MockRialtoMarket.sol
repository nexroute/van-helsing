// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

interface IERC20Rialto {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

// The vault a Rialto market keeps its inventory in, shared on chain by every market of the venue:
// here one market's own, which only that market may pay out of.
contract MockRialtoVault {
    address public immutable market;

    constructor() {
        market = msg.sender;
    }

    function pay(address token, address to, uint256 amount) external {
        require(msg.sender == market, "ONLY_MARKET");
        IERC20Rialto(token).transfer(to, amount);
    }
}

// A Rialto market for the tests, as the venue prices on Robinhood Chain: an oracle mid (token1 per
// token0, 1e18 scaled), and a half-spread chosen by the trade's size from a ladder of rungs and
// charged on the WHOLE trade, so a bigger input can buy less. The size is the trade's notional in
// token1. It holds nothing itself: swapExactIn pulls the input into its vault, with the caller's
// allowance to the market, and the vault pays the output. getAmountOut answers zero when the market
// refuses (a stale oracle), and reverts "COR" past what the vault holds.
contract MockRialtoMarket {
    address public immutable token0;
    address public immutable token1;
    MockRialtoVault private immutable vault;

    uint256 public mid;
    uint256[] private rungTop; // each rung's largest notional, in token1, ascending
    uint256[] private rungBps; // each rung's half-spread, in basis points
    bool public refuse;

    constructor(address t0, address t1, uint256 mid_) {
        token0 = t0;
        token1 = t1;
        vault = new MockRialtoVault();
        mid = mid_;
    }

    function traderVault() external view returns (address) {
        return address(vault);
    }

    function setMid(uint256 mid_) external {
        mid = mid_;
    }

    function setRungs(uint256[] calldata top, uint256[] calldata bps) external {
        rungTop = top;
        rungBps = bps;
    }

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    function getAmountOut(bool zeroForOne, uint256 amountIn) public view returns (uint256 out) {
        if (refuse) return 0;
        uint256 notional = zeroForOne ? amountIn * mid / 1e18 : amountIn;
        uint256 bps = type(uint256).max;
        for (uint256 i = 0; i < rungTop.length; ++i) {
            if (notional <= rungTop[i]) {
                bps = rungBps[i];
                break;
            }
        }
        require(bps != type(uint256).max, "COR");
        out = zeroForOne ? amountIn * mid / 1e18 : amountIn * 1e18 / mid;
        out = out * (10_000 - bps) / 10_000;
        require(out <= IERC20Rialto(zeroForOne ? token1 : token0).balanceOf(address(vault)), "COR");
    }

    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256 amountOutMin, address to, uint256)
        external
        payable
        returns (uint256 out)
    {
        out = getAmountOut(zeroForOne, amountIn);
        require(out != 0 && out >= amountOutMin, "SLIPPAGE");
        IERC20Rialto(zeroForOne ? token0 : token1).transferFrom(msg.sender, address(vault), amountIn);
        vault.pay(zeroForOne ? token1 : token0, to, out);
    }
}
