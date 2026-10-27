// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IUniswapV2Callee {
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

// Constant-product pair with a configurable fee, faithful enough for VanHelsing's
// drive (flash: output first, callback repays) and sink (pre-funded) paths. Reserves
// are the balances as of the last swap, initReserves or sync; the fee-adjusted k-invariant
// is enforced after the callback, exactly as a real UniswapV2Pair, so an under-repaid flash
// reverts.
contract MockV2Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 private immutable FEE_NUM; // e.g. 9975
    uint256 private immutable FEE_DEN; // e.g. 10000

    uint256 private r0;
    uint256 private r1;

    constructor(address t0, address t1, uint256 feeNum, uint256 feeDen) {
        require(t0 < t1, "SORT");
        token0 = t0;
        token1 = t1;
        FEE_NUM = feeNum;
        FEE_DEN = feeDen;
    }

    // Pull `_r0`/`_r1` from the caller (who must have approved) and set reserves.
    function initReserves(uint256 _r0, uint256 _r1) external {
        IERC20Min(token0).transferFrom(msg.sender, address(this), _r0);
        IERC20Min(token1).transferFrom(msg.sender, address(this), _r1);
        r0 = _r0;
        r1 = _r1;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (r0, r1);
    }

    // As UniswapV2Pair.sync: the reserves become the balances.
    function sync() external {
        r0 = IERC20Min(token0).balanceOf(address(this));
        r1 = IERC20Min(token1).balanceOf(address(this));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "OUT_0");
        require(amount0Out < r0 && amount1Out < r1, "LIQ");
        if (amount0Out > 0) IERC20Min(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Min(token1).transfer(to, amount1Out);
        if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);

        uint256 b0 = IERC20Min(token0).balanceOf(address(this));
        uint256 b1 = IERC20Min(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "IN_0");
        // fee-adjusted k: (b0*DEN - in0*(DEN-NUM)) * (b1*DEN - in1*(DEN-NUM)) >= r0*r1*DEN^2
        uint256 bal0Adj = b0 * FEE_DEN - in0 * (FEE_DEN - FEE_NUM);
        uint256 bal1Adj = b1 * FEE_DEN - in1 * (FEE_DEN - FEE_NUM);
        require(bal0Adj * bal1Adj >= r0 * r1 * (FEE_DEN * FEE_DEN), "K");
        r0 = b0;
        r1 = b1;
    }
}
