// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

interface IERC20Alg {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IAlgebraSwapCallback {
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

// An Algebra Integral pool for the tests, as Robinhood Chain's run them: no slot0, its price and
// the fee its plugin sets in globalState, and its initialized ticks kept as a linked list between
// MIN_TICK and MAX_TICK, which link to themselves, with the pool's own prevTickGlobal and
// nextTickGlobal around its tick. It swaps as MockV3SwapPool does, over one range of constant
// liquidity (the list is for depth reads; swaps do not cross it), at the fee globalState holds,
// paid in algebraSwapCallback, then checks its balance grew by the input.
contract MockAlgebraPool {
    uint256 private constant Q96 = 1 << 96;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    struct Tick {
        int128 delta;
        int24 prev;
        int24 next;
        bool init;
    }

    address public immutable token0;
    address public immutable token1;
    int24 public constant tickSpacing = 60;
    uint128 public immutable liquidity;
    uint160 private sqrtP;
    int24 private tick;
    uint16 private fee;
    mapping(int24 => Tick) private _ticks;

    constructor(address t0, address t1, uint16 fee_, uint160 sqrtPriceX96, int24 tick_, uint128 liquidity_) {
        require(t0 < t1, "SORT");
        token0 = t0;
        token1 = t1;
        fee = fee_;
        sqrtP = sqrtPriceX96;
        tick = tick_;
        liquidity = liquidity_;
        _ticks[MIN_TICK] = Tick(0, MIN_TICK, MAX_TICK, true);
        _ticks[MAX_TICK] = Tick(0, MIN_TICK, MAX_TICK, true);
    }

    // What the plugin does when it moves the fee.
    function setFee(uint16 fee_) external {
        fee = fee_;
    }

    // Initialize `t` (linking it in order) and add `delta` to its liquidityDelta, which crossing it
    // while the price rises adds, and while it falls subtracts.
    function setTick(int24 t, int128 delta) external {
        require(t > MIN_TICK && t < MAX_TICK, "RANGE");
        Tick storage n = _ticks[t];
        if (!n.init) {
            int24 below = MIN_TICK;
            while (_ticks[below].next < t) below = _ticks[below].next;
            int24 above = _ticks[below].next;
            (n.prev, n.next, n.init) = (below, above, true);
            _ticks[below].next = t;
            _ticks[above].prev = t;
        }
        n.delta += delta;
    }

    function globalState()
        external
        view
        returns (uint160 price, int24 tick_, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)
    {
        return (sqrtP, tick, fee, 0xc1, 0, true);
    }

    // (liquidityTotal, liquidityDelta, prevTick, nextTick, outerFeeGrowth0Token, outerFeeGrowth1Token)
    function ticks(int24 t) external view returns (uint256, int128, int24, int24, uint256, uint256) {
        Tick memory n = _ticks[t];
        return (n.init ? 1 : 0, n.delta, n.prev, n.next, 0, 0);
    }

    // The initialized tick at or below the pool's tick.
    function prevTickGlobal() public view returns (int24 t) {
        t = MIN_TICK;
        while (_ticks[t].next <= tick) t = _ticks[t].next;
    }

    // The initialized tick above the pool's tick.
    function nextTickGlobal() external view returns (int24) {
        return _ticks[prevTickGlobal()].next;
    }

    // amountRequired > 0 is exact input, < 0 exact output, as in Algebra's swap.
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountRequired != 0, "AS");
        require(zeroToOne ? limitSqrtPrice < sqrtP : limitSqrtPrice > sqrtP, "SPL");
        (uint256 amtIn, uint256 amtOut, uint160 next) = amountRequired > 0
            ? _exactIn(zeroToOne, uint256(amountRequired), limitSqrtPrice)
            : _exactOut(zeroToOne, uint256(-amountRequired), limitSqrtPrice);
        sqrtP = next;
        (address tIn, address tOut) = zeroToOne ? (token0, token1) : (token1, token0);
        (amount0, amount1) = zeroToOne ? (int256(amtIn), -int256(amtOut)) : (-int256(amtOut), int256(amtIn));
        if (amtOut > 0) IERC20Alg(tOut).transfer(recipient, amtOut);
        uint256 before = IERC20Alg(tIn).balanceOf(address(this));
        IAlgebraSwapCallback(msg.sender).algebraSwapCallback(amount0, amount1, data);
        require(IERC20Alg(tIn).balanceOf(address(this)) >= before + amtIn, "IIA");
    }

    // Spend up to `gross` (fee included), stopping at the price limit.
    function _exactIn(bool zfo, uint256 gross, uint160 limit) private view returns (uint256 amtIn, uint256 amtOut, uint160 next) {
        uint256 net = FixedPointMathLib.fullMulDiv(gross, 1e6 - fee, 1e6);
        uint256 toLimit = zfo ? _delta0(limit, sqrtP, true) : _delta1(sqrtP, limit, true);
        if (net >= toLimit) {
            next = limit;
            amtIn = toLimit + FixedPointMathLib.fullMulDivUp(toLimit, fee, 1e6 - fee);
        } else {
            next = zfo
                ? uint160(FixedPointMathLib.fullMulDivUp(uint256(liquidity) << 96, sqrtP, (uint256(liquidity) << 96) + net * sqrtP))
                : uint160(sqrtP + FixedPointMathLib.fullMulDiv(net, Q96, liquidity));
            amtIn = gross;
        }
        amtOut = zfo ? _delta1(next, sqrtP, false) : _delta0(sqrtP, next, false);
    }

    // Buy exactly `out`, which must not push the price past the limit.
    function _exactOut(bool zfo, uint256 out, uint160 limit) private view returns (uint256 amtIn, uint256 amtOut, uint160 next) {
        if (zfo) {
            next = uint160(sqrtP - FixedPointMathLib.fullMulDivUp(out, Q96, liquidity));
            require(next > limit, "LIMIT");
            amtIn = _delta0(next, sqrtP, true);
        } else {
            uint256 l96 = uint256(liquidity) << 96;
            next = uint160(FixedPointMathLib.fullMulDivUp(l96, sqrtP, l96 - out * sqrtP));
            require(next < limit, "LIMIT");
            amtIn = _delta1(sqrtP, next, true);
        }
        amtIn += FixedPointMathLib.fullMulDivUp(amtIn, fee, 1e6 - fee);
        amtOut = out;
    }

    // token0 between sqrt prices a < b: L * (b - a) / (a * b), scaled by 2^96.
    function _delta0(uint160 a, uint160 b, bool up) private view returns (uint256) {
        uint256 l96 = uint256(liquidity) << 96;
        return up
            ? FixedPointMathLib.fullMulDivUp(FixedPointMathLib.fullMulDivUp(l96, b - a, b), 1, a)
            : FixedPointMathLib.fullMulDiv(l96, b - a, b) / a;
    }

    // token1 between sqrt prices a < b: L * (b - a) / 2^96.
    function _delta1(uint160 a, uint160 b, bool up) private view returns (uint256) {
        return up ? FixedPointMathLib.fullMulDivUp(liquidity, b - a, Q96) : FixedPointMathLib.fullMulDiv(liquidity, b - a, Q96);
    }
}
