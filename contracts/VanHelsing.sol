// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.27;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { IPoolRegistry } from "./interfaces/IPoolRegistry.sol";
import { MeetingPrice } from "./libraries/MeetingPrice.sol";
import { V3Depth } from "./libraries/V3Depth.sol";
import { V4Depth } from "./libraries/V4Depth.sol";
import { DepthRecord } from "./libraries/DepthRecord.sol";
import { V2Lib } from "./libraries/V2Lib.sol";
import { V3Lib } from "./libraries/V3Lib.sol";
import { Chain } from "./libraries/Chain.sol";
import { V4Config } from "./libraries/V4Config.sol";
import { UniV4Lib } from "./libraries/UniV4Lib.sol";
import { InfinityLib } from "./libraries/InfinityLib.sol";
import { CurveLib } from "./libraries/CurveLib.sol";
import { RouteLib, Cx } from "./libraries/RouteLib.sol";

using SafeTransferLib for address;

// Van Helsing, an on-chain arbitrageur called inside a transaction: ward(id) prices the pool
// `id` against its anchor and, when the two are apart by more than their fees, trades them to
// the price where they meet and pays what that captures as a bounty.
// Invariants that make it safe:
//   (1) STATELESS + FUNDLESS: nothing to steal; every flash self-repays or the
//       whole execute() frame reverts and rolls back.
//   (2) ward() NEVER REVERTS the caller: execute() runs in a self-delegatecall
//       whose result is ignored, so any failure is a no-op for the caller.
//   (3) CALL-only into untrusted code: VanHelsing delegatecalls only itself and its own
//       immutable, deploy-time-linked libraries, never attacker-controlled code.
//   (4) REGISTRY-SOURCED POOLS: both the warded pool and its anchor are pools the registry's
//       operator listed; a bad entry only wastes gas or captures less, never steals.
//
// The bounty, what the restore captured, goes to the `payee` the caller names (the caller
// itself when `payee` is zero), less VanHelsing's CUT_BPS, which goes to the TREASURY. The
// anchor, the pool whose price counts as fair, is always the first pool the registry lists
// for the pair other than the warded one: the operator keeps each list deepest first, so it
// is the deepest other pool, and a caller has no say in it. In the code the warded pool is
// `def`, the defended pool, and its anchor `alt`.
//
// One algorithm, one path: normalize both pools to (sqrtPrice, liquidity, fee), size to the
// fee-adjusted meeting price, flash-drive one pool to its final price (output first, pay in
// the callback), sink the output into the other (which reaches its own final by absorbing the
// flow), and repay. Protocol specifics live behind per-kind dispatches (_normalize, _walkLiq,
// _flashDrive, _sinkOne, the callbacks, and the small kind checks beside them), so adding a
// protocol is a new adapter library plus a case in each, not edits across the core.
contract VanHelsing {
    // The reentrancy lock's transient slot (EIP-1153), apart from the callback context's:
    // keccak256("VanHelsing.reentrancy.lock") - 1.
    uint256 private constant LOCK_SLOT = 0xe1dd7ee46baa040834362158a405a4aaf856a0e037e8a5cb0b045edc214e05b1;

    // The callback context's transient slot. While a swap is in flight it holds
    // (mode << 168 | kind << 160 | caller): the expected caller (the pool, or a singleton's
    // manager or vault), its protocol, and which handler its callback routes to (0 =
    // inactive). Authenticating msg.sender against `caller` means a token that reenters
    // during the pool's output transfer cannot forge a callback.
    // keccak256("VanHelsing.callback.context") - 1.
    uint256 private constant CTX_SLOT = 0xf1c3114c33a6b856dd7ba15926f91270ebd417785a6f47a226cd57657ae19850;

    // The sink's price limit while a ward runs: one full gap past the driver's price before the
    // drive (sqrt price driver^2 / sink), farther than a restore that pays ever takes the sink, so a
    // sink that runs dry stops there and the ward fails cheaply, while one a little shallower than
    // its depth read still completes; 0, the open limit, for a route, whose hops move at their own
    // prices. Every ward that drives into a concentrated pool or a route sets it (_meet); no other
    // sink reads it. keccak256("VanHelsing.sink.limit") - 1.
    uint256 private constant SINK_LIMIT_SLOT = 0x4d2a5aab6e626f91371f5183d02c858bc2c7d869827b1c178fb1c78156b67583;

    // TickMath sqrt-ratio bounds (a price/target is clamped inside them).
    uint160 private constant MIN_SQRT = 4295128739 + 1;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    // The steps a depth walk takes per concentrated leg, each to the next initialized tick or
    // to the end of a bitmap word (256 spacings). It bounds the walk's gas; the walk also
    // stops at its target or where the liquidity runs out.
    uint256 private constant MAX_DEPTH_TICKS = 8;

    // A pool's amounts are its liquidity times sqrt prices scaled by 2^96.
    uint256 private constant Q96 = 1 << 96;

    // Protocol kinds, as the registry numbers them.
    uint8 private constant V2 = 0; // Uniswap V2-style pair (constant product)
    uint8 private constant V3 = 2; // Uniswap V3-style pool (concentrated liquidity)
    // Algebra Integral pool, in a build for a chain that has them (Chain.ALGEBRA, 1): traded as a
    // V3 pool, read by globalState and its tick links. V3 and Algebra swap, call back and are paid
    // alike, so every path but the reads (_normalize, _walkLiq) tests both at once, `kind >>
    // Chain.ALGEBRA == V3 >> Chain.ALGEBRA`, as 2 and 3 differ in the last bit only. A build
    // without them shifts by 0: `kind == V3`.
    uint8 private constant ALGEBRA = 3;
    uint8 private constant UNIV4 = 4; // Uniswap V4 pool (singleton): flashes inside the manager's lock
    uint8 private constant CURVE = 5; // Curve stableswap (int128 exchange): sink only, cannot flash
    uint8 private constant INFI = 6; // Pancake Infinity CL pool (singleton): flashes inside the Vault's lock
    uint8 private constant STABLE = 7; // Pancake StableSwap (uint256 exchange): sink only
    uint8 private constant RIALTO = 11; // Rialto market (oracle-priced, Robinhood Chain): sink only
    uint8 private constant TESSERA = 25; // Tessera (oracle-priced, one entry for every pair, Robinhood Chain): sink only
    uint8 private constant ROUTE = 200; // 2-hop virtual pool (sink only, never drives)
    uint8 private constant NONE = 255; // Cx.sinkKind2 sentinel: direct (1-hop) sink

    // Transfer taxes are basis points (IPoolRegistry.Pool.tax).
    uint256 private constant TAX_ONE = 1e4;
    uint32 private constant NATIVE = 1 << 24; // IPoolRegistry.Pool.shape: currency0 is native

    // The registry's poolKeys mapping, slot 6 of its layout (PoolRegistry), whose word _cfg
    // reads through the registry's read to unpack a singleton pool's config.
    uint256 private constant REG_POOL_KEYS = 6;

    // Callback-context modes, packed above the kind and caller in CTX_SLOT: the driven pool called
    // back, to sink its output and repay it; or a nested sink called back, to pay a V3 pool, or to
    // swap and settle in the V4 or Infinity lock taken for it.
    uint256 private constant CB_DRIVE = 1;
    uint256 private constant CB_SINK = 2;

    IPoolRegistry public immutable REGISTRY;
    // This code's own address, which ward() delegatecalls execute at: behind the proxy, the
    // implementation, so the attempt does not go through the proxy a second time.
    address private immutable SELF;
    // Where Van Helsing's share of every bounty goes, CUT_BPS of 10_000 of it; the rest goes to
    // `payee`.
    address public immutable TREASURY;
    uint256 public constant CUT_BPS = 1_000;

    // A ward closed a gap: `pool` was restored against `anchor`. `bounty` is the whole capture,
    // in `token`; `payee` received all of it but CUT_BPS (all of it when it is the TREASURY).
    event Captured(bytes32 indexed pool, bytes32 indexed anchor, address indexed payee, address token, uint256 bounty);

    // The drive-callback context `Cx` (what to sink and how to repay) is a file-level
    // struct declared in RouteLib.sol, shared so RouteLib.cxRoute can build the route
    // variant; a direct sink's is built by _cx below.

    constructor(IPoolRegistry registry, address treasury) {
        REGISTRY = registry;
        TREASURY = treasury;
        SELF = address(this);
    }

    // Non-reverting entry. A failed attempt reverts only its own delegatecall frame, so the
    // caller's transaction is never taken down. The bounty goes to `payee`, or to the caller
    // when `payee` is zero, less VanHelsing's CUT_BPS. The pool is restored against its anchor,
    // the first other pool the registry lists for its pair.
    function ward(bytes32 id, address payee) external {
        _attempt(id, payee, type(uint256).max);
    }

    // The same, with the attempt held to at most maxGas. One that needs more does nothing, and
    // the caller keeps the rest of its gas: a hook or a router can call it plainly and lose at
    // most maxGas to it, plus the call's own few thousand gas.
    function ward(bytes32 id, address payee, uint256 maxGas) external {
        _attempt(id, payee, maxGas);
    }

    // execute runs in a self-delegatecall whose outcome is ignored, with all the gas left (less the
    // 1/64 the EVM keeps back) or maxGas, whichever is less. Assembly keeps the call from
    // copying back return data, so no revert, however long, can make ward() itself run out.
    function _attempt(bytes32 id, address payee, uint256 maxGas) private {
        bytes4 selector = this.execute.selector;
        address self = SELF;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, selector)
            mstore(add(p, 0x04), id)
            mstore(add(p, 0x24), payee)
            let g := gas()
            if lt(maxGas, g) { g := maxGas }
            pop(delegatecall(g, self, p, 0x44, 0, 0))
        }
    }

    // The arb. May revert freely; only meant to be reached through ward() (or a direct call by
    // anyone willing to eat the revert). Fundless, so a direct call is harmless. `id` is the
    // warded pool's registry id: a pool contract's address zero-padded to bytes32, or a
    // singleton pool's poolId. A zero `payee` is msg.sender, which inside ward's delegatecall
    // is ward's own caller. The anchor is the first ranked id that is not the warded pool,
    // read with its entry in the same registry call as the warded pool's (wardPools). The
    // ranking is deepest first, so this is the fair anchor. No look at the rest: if the pool
    // is not dislocated against its anchor there is nothing to capture.
    function execute(bytes32 id, address payee) external nonReentrant {
        (IPoolRegistry.Pool memory def, address t0, address t1, bool ok, IPoolRegistry.Pool memory alt) = _wardPools(id);
        require(ok, "UNREGISTERED");
        require(alt.id != bytes32(0), "NO_ALT");

        _restore(def, alt, t0, t1, payee == address(0) ? msg.sender : payee);
    }

    // REGISTRY.wardPools(id), its 13 words left where they land: each Pool is 5 words in memory
    // as in the return data, so `def` and `alt` point into it. The registry writes every field
    // clean, so nothing is decoded.
    function _wardPools(bytes32 id)
        private
        view
        returns (IPoolRegistry.Pool memory def, address t0, address t1, bool ok, IPoolRegistry.Pool memory alt)
    {
        address registry = address(REGISTRY);
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(0, 0x47da490d) // wardPools(bytes32)
            mstore(0x20, id)
            if iszero(and(gt(returndatasize(), 0x19f), staticcall(gas(), registry, 0x1c, 0x24, p, 0x1a0))) {
                revert(0, 0)
            }
            mstore(0x40, add(p, 0x1a0))
            def := p
            t0 := mload(add(p, 0xa0))
            t1 := mload(add(p, 0xc0))
            ok := mload(add(p, 0xe0))
            alt := add(p, 0x100)
        }
    }

    // Size to the meeting price, flash-drive a flash-capable leg to its final, sink the output
    // into the other pool (which reaches its own final by absorbing the flow), pay the profit
    // out. The defended pool drives when it can flash (_canDrive); when it cannot (a
    // stableswap), the alt drives and the defended pool is the sink, still restored. With
    // neither able to flash there is no fundless source: no-op. On a pair with a
    // transfer-taxed token the leg that token flows out of drives (_taxFold).
    function _restore(IPoolRegistry.Pool memory def, IPoolRegistry.Pool memory alt, address t0, address t1, address payee)
        private
    {
        (IPoolRegistry.Pool memory driver, IPoolRegistry.Pool memory sink, uint160 target, uint160 cur) =
            _pickDriver(def, alt, t0, t1);
        require(cur != target, "NO_ARB");
        (address token, uint256 bounty) = _drive(driver, sink, target, cur > target, t0, t1);
        _pay(token, bounty, payee);
        emit Captured(def.id, alt.id, payee, token, bounty);
    }

    // Split a bounty: CUT_BPS of it to the treasury, the rest to `payee`, rounded in `payee`'s
    // favor. A treasury that wards for itself takes it all in one transfer.
    function _pay(address token, uint256 bounty, address payee) private {
        uint256 cut = payee == TREASURY ? bounty : bounty * CUT_BPS / 10_000;
        if (cut != 0) token.safeTransfer(TREASURY, cut);
        if (cut != bounty) token.safeTransfer(payee, bounty - cut);
    }

    // Payout choice + flash-drive for the chosen driver/sink; returns the bounty and its
    // token, which _restore pays out. Split out so _restore's stack stays small (no
    // viaIR). zeroForOne is the driver's direction (its current price above the target ->
    // lower it by adding token0).
    function _drive(
        IPoolRegistry.Pool memory driver,
        IPoolRegistry.Pool memory sink,
        uint160 target,
        bool zeroForOne,
        address t0,
        address t1
    ) private returns (address base, uint256 profit) {
        bool exactOut;
        uint256 floor;
        Cx memory c;
        if (sink.kind == ROUTE) {
            // Cold path, in the externally linked RouteLib for bytecode headroom.
            bool profitAtMid;
            (base, profitAtMid, floor) = RouteLib.payoutRoute(REGISTRY, sink.id, t0, t1, zeroForOne);
            c = RouteLib.cxRoute(REGISTRY, sink.id, t0, t1, zeroForOne, profitAtMid);
        } else {
            // A taxed pair is paid exact-in: the profit lands in the untaxed token, the one
            // the sink pays out (see _taxFold).
            (base, exactOut, floor) = _payout(t0, t1, zeroForOne, _isStable(sink.kind) || (driver.tax | sink.tax) != 0);
            c = _cx(sink, t0, t1, zeroForOne, exactOut);
        }
        _flashDrive(driver, target, zeroForOne, c);
        profit = base.balanceOf(address(this));
        require(profit > floor, "BELOW_FLOOR");
    }

    // Choose which leg to drive: the defended if it is flash-capable, else the alt; on a
    // taxed pair, the leg the taxed token flows out of (_taxFold). The other becomes the
    // sink. Returns the driver's meeting-price target and its current price. Reverts
    // UNSUPPORTED if the chosen leg cannot flash.
    function _pickDriver(IPoolRegistry.Pool memory def, IPoolRegistry.Pool memory alt, address t0, address t1)
        private
        returns (IPoolRegistry.Pool memory driver, IPoolRegistry.Pool memory sink, uint160 target, uint160 cur)
    {
        bool defDrives;
        (target, cur, defDrives) = _meet(def, alt, t0, t1);
        if (defDrives) { (driver, sink) = (def, alt); } else { (driver, sink) = (alt, def); }
        require(_canDrive(driver.kind), "UNSUPPORTED");
    }

    // Flash-capable protocols (output-first swap). A stableswap's pre-funded exchange
    // has no flash mode, so it can only ever be a sink.
    function _canDrive(uint8 kind) private pure returns (bool) {
        return kind == V2 || kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA || kind == UNIV4 || kind == INFI;
    }

    // The kinds a ward can only sink into, handled by CurveLib: the Curve-style stableswaps and the
    // market makers, one bit each, so the test is one shift whatever their number.
    uint256 private constant SINK_ONLY = 1 << CURVE | 1 << STABLE | 1 << RIALTO | 1 << TESSERA;

    function _isStable(uint8 kind) private pure returns (bool) {
        return (SINK_ONLY >> kind) & 1 != 0;
    }

    // Build the drive callback's context (isolated to keep _drive's stack small).
    // got = zeroForOne ? t1 : t0 (the drive's output); we sink it into the other pool.
    function _cx(IPoolRegistry.Pool memory sink, address t0, address t1, bool zeroForOne, bool exactOut)
        private
        pure
        returns (Cx memory c)
    {
        address gotToken = zeroForOne ? t1 : t0;
        c = Cx({
            gotToken: gotToken,
            owedToken: zeroForOne ? t0 : t1,
            owed: 0,
            sinkId: sink.id,
            sinkKind: sink.kind,
            sinkFee: sink.fee,
            exactOut: exactOut,
            sinkId2: bytes32(0),
            sinkKind2: NONE,
            sinkFee2: 0,
            mid: address(0),
            profitAtMid: false,
            sinkTaxIn: uint16(sink.tax >> (zeroForOne ? 16 : 48))
        });
    }

    // Flash-drive the driver to `target` (output first, pay in the callback). A V3 pool swaps
    // to the price limit; a V2 pair flashes the output of the fee-aware amount that reaches
    // `target` (V2Lib.driveAmount); a singleton pool is driven inside its manager's lock
    // (_driveV4, _driveInfi). The CB_DRIVE callback sinks the output and repays.
    function _flashDrive(IPoolRegistry.Pool memory driver, uint160 target, bool zeroForOne, Cx memory c) private {
        if (driver.kind == UNIV4) {
            _driveV4(_cfg(UNIV4, driver.id, c.gotToken, c.owedToken), target, zeroForOne, c);
            return;
        }
        if (driver.kind == INFI) {
            _driveInfi(_cfg(INFI, driver.id, c.gotToken, c.owedToken), target, zeroForOne, c);
            return;
        }
        address pool = _addr(driver.id); // V2/V3 id is the pool address, padded
        _setCtx(CB_DRIVE, driver.kind, pool);
        if (driver.kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA) {
            V3Lib.driveTo(pool, zeroForOne, target, abi.encode(c));
        } else {
            _flashDriveV2(pool, driver.fee, target, zeroForOne, c);
        }
        _clearCtx();
    }

    // Drive a Uniswap V4 pool. Unlike V2/V3 (the pool calls us back), a V4 swap runs inside the
    // PoolManager's lock, so we unlock it and run the whole restore in unlockCallback. CTX pins
    // the PoolManager (a pool has no address) so the callback authenticates it. Split out to
    // keep _flashDrive's stack small.
    function _driveV4(bytes memory cfg, uint160 target, bool zeroForOne, Cx memory c) private {
        _setCtx(CB_DRIVE, UNIV4, address(UniV4Lib.POOL_MANAGER));
        UniV4Lib.unlock(abi.encode(cfg, target, zeroForOne, c));
        _clearCtx();
    }

    // Drive a Pancake Infinity CL pool as _driveV4 drives a V4 pool, but the lock is the
    // Vault's (lockAcquired) and the CTX pins the Vault.
    function _driveInfi(bytes memory cfg, uint160 target, bool zeroForOne, Cx memory c) private {
        _setCtx(CB_DRIVE, INFI, address(InfinityLib.VAULT));
        InfinityLib.unlock(abi.encode(cfg, target, zeroForOne, c));
        _clearCtx();
    }

    function _flashDriveV2(address pool, uint32 fee, uint160 target, bool zeroForOne, Cx memory c) private {
        (uint256 r0, uint256 r1) = V2Lib.getReserves(pool);
        (uint256 fn, uint256 fd) = _feeMul(V2, fee);
        uint256 a = V2Lib.driveAmount(r0, r1, fn, fd, target, zeroForOne);
        require(a > 0, "NO_ARB");
        (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
        uint256 otherOut = V2Lib.amountOut(a, rIn, rOut, fn, fd);
        c.owed = a; // the debt is known up front for a V2 flash
        V2Lib.flash(pool, otherOut, zeroForOne, address(this), abi.encode(c));
    }

    // Drive-swap callback: the driven pool sent us `got` and we owe it `owed`. Sink
    // `got` into the other pool to source `owed`, then repay the drive. msg.sender is the
    // driven pool, already authenticated by the fallback; `kind` is its protocol.
    function _onDrive(uint8 kind, bytes calldata data) private returns (bytes memory) {
        address drive = msg.sender;
        Cx memory c;
        uint256 owed;
        // Scope the decode so intermediates free before the sink call (no viaIR).
        {
            if (kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA) {
                (int256 a0, int256 a1, bytes memory cxb) = abi.decode(data[4:], (int256, int256, bytes));
                c = abi.decode(cxb, (Cx));
                owed = V3Lib.owed(a0, a1); // the positive delta is the input we owe
            } else {
                (,,, bytes memory cxb) = abi.decode(data[4:], (address, uint256, uint256, bytes));
                c = abi.decode(cxb, (Cx));
                owed = c.owed;
            }
        }

        _sink(c, owed, drive, kind);
        c.owedToken.safeTransfer(drive, owed);
        return "";
    }

    // Sell `got` into the sink to source `owed` (exact output, residual is profit) or
    // to spend all of `got` (exact input). Dispatches on the sink's kind. A direct sink
    // is one call; a route sink runs two.
    function _sink(Cx memory c, uint256 owed, address drive, uint8 driveKind) private {
        if (c.sinkKind2 == NONE) {
            _sinkOne(c.sinkKind, c.sinkId, c.sinkFee, c.gotToken, c.owedToken, owed, c.exactOut, c.sinkTaxIn, drive, driveKind);
            return;
        }
        // route: hop 1 dumps all `got` into the bridge (exact-in, output `mid`); hop 2
        // turns `mid` into the owed token, exact-in (profit at the end) or exact-out for
        // `owed` (profit stays in mid).
        _sinkOne(c.sinkKind, c.sinkId, c.sinkFee, c.gotToken, c.mid, 0, false, c.sinkTaxIn, drive, driveKind);
        _sinkOne(c.sinkKind2, c.sinkId2, c.sinkFee2, c.mid, c.owedToken, owed, c.profitAtMid, 0, drive, driveKind);
    }

    // One sink hop. `tokenIn` is what we spend and `tokenOut` what we buy; the hop's
    // direction is their ERC20 order (zeroForOne when tokenIn is the lower address, the pool's
    // token0). exactOut buys exactly `owed` of tokenOut (profit stays in tokenIn), else spends
    // the whole tokenIn balance (profit in tokenOut). A V3 hop pays via the nested CB_SINK
    // callback; V2/stableswap are pre-funded; V4/Infinity swap inside a (possibly nested)
    // lock. `taxIn` is the transfer tax tokenIn loses entering this pool, in basis points.
    function _sinkOne(
        uint8 kind,
        bytes32 id,
        uint32 fee,
        address tokenIn,
        address tokenOut,
        uint256 owed,
        bool exactOut,
        uint16 taxIn,
        address drive,
        uint8 driveKind
    ) private {
        if (kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA) {
            int256 amount = exactOut ? -int256(owed) : _v3In(tokenIn, taxIn);
            address sink = _addr(id);
            _setCtx(CB_SINK, V3, sink);
            V3Lib.sink(sink, tokenIn < tokenOut, amount, _sinkLimit(), abi.encode(tokenIn, !exactOut && taxIn != 0));
            _setCtx(CB_DRIVE, driveKind, drive); // restore for the repay that follows
        } else if (kind == V2) {
            _sinkV2(id, fee, tokenIn, tokenIn < tokenOut, owed, exactOut);
        } else if (kind == UNIV4) {
            _sinkV4(id, tokenIn, tokenOut, owed, exactOut, drive, driveKind);
        } else if (kind == INFI) {
            _sinkInfi(id, tokenIn, tokenOut, owed, exactOut, drive, driveKind);
        } else {
            // Stableswap (CURVE/STABLE): pre-funded exact-in, output straight to us.
            CurveLib.sink(kind, _addr(id), tokenIn, tokenOut, tokenIn.balanceOf(address(this)));
        }
    }

    // A V3 exact-in sink's amountSpecified: the whole balance, or for a taxed tokenIn what
    // will arrive of it. The pool checks its balance after the callback, so it is asked
    // for the taxed amount (less a wei for a token that rounds its fee up) and the
    // callback pays the whole balance (V3Lib.pay).
    function _v3In(address tokenIn, uint16 taxIn) private view returns (int256) {
        uint256 bal = tokenIn.balanceOf(address(this));
        return int256(taxIn == 0 ? bal : bal * (TAX_ONE - taxIn) / TAX_ONE - 1);
    }

    // Sink into a Uniswap V4 pool. If a V4 pool drove, we already hold the manager's lock, so
    // swap and settle inline: the drive's and sink's deltas net on the shared manager (buy
    // `owed` exact-out, or spend all `got` exact-in; V4's amount signs are the reverse of
    // V3's). If another pool drove, we do NOT hold the lock, so take it now via a nested
    // unlock routed to unlockCallback's CB_SINK arm, then restore CTX for the repay.
    function _sinkV4(bytes32 id, address tokenIn, address tokenOut, uint256 owed, bool exactOut, address drive, uint8 driveKind)
        private
    {
        bytes memory sm = _cfg(UNIV4, id, tokenIn, tokenOut);
        bool zfo = tokenIn < tokenOut;
        int256 amt = exactOut ? int256(owed) : -int256(tokenIn.balanceOf(address(this)));
        if (driveKind == UNIV4) {
            _v4SinkSwap(sm, zfo, amt); // already hold the lock
        } else {
            _setCtx(CB_SINK, UNIV4, address(UniV4Lib.POOL_MANAGER));
            UniV4Lib.unlock(abi.encode(sm, zfo, amt));
            _setCtx(CB_DRIVE, driveKind, drive);
        }
    }

    // Swap got -> owed on a V4 sink and settle the got debt (the owed output is taken to
    // us). Shared by the same-lock sink above and the nested sink (_onSinkV4). Exact-in
    // (amt < 0) pays first, so a token taking a fee on transfer cannot leave the manager
    // short (UniV4Lib.sinkIn).
    function _v4SinkSwap(bytes memory sm, bool zfo, int256 amt) private {
        if (amt < 0) {
            UniV4Lib.sinkIn(sm, zfo, uint256(-amt), _sinkLimit());
            return;
        }
        (uint256 gotDebt,) = UniV4Lib.swapTo(sm, zfo, amt, _sinkLimitOr(zfo));
        UniV4Lib.settleDebt(sm, zfo, gotDebt);
    }

    // Pancake Infinity CL sink, the Vault's counterpart of _sinkV4: inline when an Infinity pool
    // drove (we hold the Vault's lock), else inside a nested lock.
    function _sinkInfi(bytes32 id, address tokenIn, address tokenOut, uint256 owed, bool exactOut, address drive, uint8 driveKind)
        private
    {
        bytes memory sm = _cfg(INFI, id, tokenIn, tokenOut);
        bool zfo = tokenIn < tokenOut;
        int256 amt = exactOut ? int256(owed) : -int256(tokenIn.balanceOf(address(this)));
        if (driveKind == INFI) {
            _infiSinkSwap(sm, zfo, amt);
        } else {
            _setCtx(CB_SINK, INFI, address(InfinityLib.VAULT));
            InfinityLib.unlock(abi.encode(sm, zfo, amt));
            _setCtx(CB_DRIVE, driveKind, drive);
        }
    }

    // The Infinity counterpart of _v4SinkSwap, exact-in paying first the same way.
    function _infiSinkSwap(bytes memory sm, bool zfo, int256 amt) private {
        if (amt < 0) {
            InfinityLib.sinkIn(sm, zfo, uint256(-amt), _sinkLimit());
            return;
        }
        (uint256 gotDebt,) = InfinityLib.swapTo(sm, zfo, amt, _sinkLimitOr(zfo));
        InfinityLib.settleDebt(sm, zfo, gotDebt);
    }

    // Exact-in pays first and prices what the pair received (V2Lib.swapAllIn), so a
    // token taking a fee on transfer cannot break the pair's invariant.
    function _sinkV2(bytes32 id, uint32 fee, address tokenIn, bool zfo, uint256 owed, bool exactOut) private {
        address sink = _addr(id);
        (uint256 fn, uint256 fd) = _feeMul(V2, fee);
        if (!exactOut) {
            V2Lib.swapAllIn(sink, tokenIn, tokenIn.balanceOf(address(this)), zfo, fn, fd, address(this));
            return;
        }
        uint256 amtIn;
        // Scope reserves so they free before the swap call (no viaIR).
        {
            (uint256 r0, uint256 r1) = V2Lib.getReserves(sink);
            (uint256 rIn, uint256 rOut) = zfo ? (r0, r1) : (r1, r0);
            amtIn = V2Lib.amountIn(owed, rIn, rOut, fn, fd);
        }
        V2Lib.swapTo(sink, tokenIn, amtIn, owed, zfo, address(this));
    }

    // V3 sink callback: pay the pool the `got` we owe it (the positive delta).
    // msg.sender is the sink pool, already authenticated by the fallback.
    function _onSink(bytes calldata data) private returns (bytes memory) {
        V3Lib.pay(data);
        return "";
    }

    // Uniswap V4 lock callback. The PoolManager calls this by selector (not the shared
    // fallback) during our own unlock; the CTX pin authenticates it as the fallback
    // does. When someone else already holds the lock (a hook, a router's unlock callback),
    // UniV4Lib.unlock calls it from this contract instead, so a self-call passes too. CB_SINK:
    // a nested V4 sink (another pool drove). Drive: the lock is open, so we do everything:
    // drive the pool to `target` (exact-in capped at the target price; V4's exact-in amount is
    // negative), sink the output into the other pool to source the input we owe, then settle
    // to close the delta. A V2, V3 or stableswap sink takes the same _sink path as under any
    // driver (a V3 sink's own callback routes through the fallback, with CTX re-pinned around it).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint256 ctx = _ctx();
        require(ctx != 0 && (msg.sender == address(uint160(ctx)) || msg.sender == address(this)), "BAD_CB");
        if ((ctx >> 168) == CB_SINK) return _onSinkV4(data); // another pool drove; it sinks into V4
        (bytes memory cfg, uint160 target, bool zeroForOne, Cx memory c) =
            abi.decode(data, (bytes, uint160, bool, Cx));
        (uint256 debt,) = UniV4Lib.swapTo(cfg, zeroForOne, -(type(int256).max / 2), target);
        _sink(c, debt, msg.sender, UNIV4);
        UniV4Lib.settleDebt(cfg, zeroForOne, debt);
        return abi.encode(uint256(0));
    }

    // Nested V4 sink: another pool drove (V2, V3 or Infinity) and we took the lock only to
    // sink. Swap on the sink and settle what we owe it from our balance; the output is taken
    // to us, for the next hop or the driver's repay.
    function _onSinkV4(bytes calldata data) private returns (bytes memory) {
        (bytes memory sm, bool zfo, int256 amt) = abi.decode(data, (bytes, bool, int256));
        _v4SinkSwap(sm, zfo, amt);
        return abi.encode(uint256(0));
    }

    // Pancake Infinity lock callback, the Vault's counterpart of unlockCallback. The Vault calls
    // this during our lock; CTX pins the Vault. Inside a lock someone else holds,
    // InfinityLib.unlock calls it from this contract instead. Drive: swap to target, sink,
    // settle. CB_SINK: a nested Infinity sink (another pool drove).
    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        uint256 ctx = _ctx();
        require(ctx != 0 && (msg.sender == address(uint160(ctx)) || msg.sender == address(this)), "BAD_CB");
        if ((ctx >> 168) == CB_SINK) return _onSinkInfi(data);
        (bytes memory cfg, uint160 target, bool zeroForOne, Cx memory c) =
            abi.decode(data, (bytes, uint160, bool, Cx));
        (uint256 debt,) = InfinityLib.swapTo(cfg, zeroForOne, -(type(int256).max / 2), target);
        _sink(c, debt, msg.sender, INFI);
        InfinityLib.settleDebt(cfg, zeroForOne, debt);
        return abi.encode(uint256(0));
    }

    function _onSinkInfi(bytes calldata data) private returns (bytes memory) {
        (bytes memory sm, bool zfo, int256 amt) = abi.decode(data, (bytes, bool, int256));
        _infiSinkSwap(sm, zfo, amt);
        return abi.encode(uint256(0));
    }

    // Both legs' normalized meet inputs, held in memory (not the stack): _meet's
    // normalize/walk/cap pipeline plus the four final prices it works out (sdF1, saF1, sdF,
    // saF) exceed the stack limit as flat locals (the code compiles without viaIR), so only
    // this struct's pointer stays on the stack, like Cx for the drive callback context. A
    // leg's s is its sqrtPriceX96, l its liquidity, n/d its fee multiplier: sd, ld, nd, dd for
    // the defended pool, the rest for the alt.
    struct MeetIn {
        uint160 sd;
        uint256 ld;
        uint256 nd;
        uint256 dd;
        uint160 sa;
        uint256 la;
        uint256 na;
        uint256 da;
        uint256 g; // G = P*gamma, MeetingPrice's fee wedge, the same for both legs' meets
    }

    // The records of both legs' pass-1 depth walks, from which pass 2 replays its walks
    // (DepthRecord). Held apart from MeetIn so a ward that stops at the fee check never
    // allocates them.
    struct Walks {
        bytes d;
        bytes a;
    }

    // Which leg drives, and the driver's final price at the fee-adjusted two-pool optimum
    // (clamped to the tick bounds) and its current price (for the drive direction). Each
    // pool normalizes to (sqrtPrice, liquidity, fee); a concentrated leg's liquidity
    // is the depth the restore actually trades through (walked toward the other
    // pool's price), not the spot active tick: otherwise a thin active tick beside
    // deep liquidity reads as shallow and mis-sizes the restore; a stable leg's
    // liquidity is additionally capped by its payable capacity over the restore
    // interval (see CurveLib.depth). Two-pass: each concentrated leg is re-sized at its
    // own pass-1 meeting price (the true, shorter restore segment) before the final
    // meet, so a leg that is deep near its price and thin farther out reads the depth it
    // trades through, not a mean diluted by the thin range past it (see _pass2).
    function _meet(IPoolRegistry.Pool memory def, IPoolRegistry.Pool memory alt, address t0, address t1)
        private
        returns (uint160 target, uint160 cur, bool defDrives)
    {
        MeetIn memory m;
        (m.sd, m.ld, m.nd, m.dd) = _normalize(def, t0, t1);
        (m.sa, m.la, m.na, m.da) = _normalize(alt, t0, t1);
        defDrives = _canDrive(def.kind);
        // The fee check: if the price gap is within the round-trip fee, no restore can
        // profit, so return target == cur and _restore no-ops (NO_ARB), skipping both walks
        // and both meets. Liquidity-independent, so it never drops a restore the full sizing
        // would profitably make (see MeetingPrice.noArb). It runs on the fees alone first: a
        // transfer tax only widens the wedge, so a pair it clears is checked again below
        // with the tax folded in.
        if (MeetingPrice.noArb(m.sd, m.nd, m.dd, m.sa, m.na, m.da)) return _live(m, defDrives);
        if ((def.tax | alt.tax) != 0) {
            defDrives = _taxFold(def.tax, alt.tax, m);
            if (MeetingPrice.noArb(m.sd, m.nd, m.dd, m.sa, m.na, m.da)) return _live(m, defDrives);
        }
        m.g = FixedPointMathLib.sqrt(MeetingPrice.wedge2(m.nd, m.dd, m.na, m.da));
        // pass 1: walk each leg toward the OTHER pool's current price, then the stable cap. A walk
        // that runs dry keeps where in its record (DepthRecord.cliffOf), which caps the restore below.
        Walks memory w;
        (m.ld, w.d) = _legLiq(def, m.ld, m.sd, m.sa, t0, t1, false);
        (m.la, w.a) = _legLiq(alt, m.la, m.sa, m.sd, t0, t1, false);
        // A sink with no liquidity between its price and the driver's absorbs nothing: no restore,
        // rather than the full one MeetingPrice falls back to for a zero depth.
        if ((defDrives ? m.la : m.ld) == 0) return _live(m, defDrives);
        // pass 2: re-size each CONCENTRATED leg at its OWN pass-1 meeting price (the true,
        // shorter restore segment) and combine DIRECTIONALLY: the driver keeps the deeper of
        // pass-1/pass-2 (a short walk inside a thin range never shrinks it), the sink the
        // shallower (the conservative shorter-segment read; see _pass2 for a sink in a gap).
        // defDrives is the driver/sink split _pickDriver applies; exactly one leg drives in any
        // valid ward. sdF1/saF1 are scoped so they do not persist into the final meet (no viaIR).
        {
            (uint160 sdF1, uint160 saF1) = _finals(m, defDrives);
            m.ld = _pass2(def, m.ld, sdF1, defDrives, t1, w.d);
            m.la = _pass2(alt, m.la, saF1, !defDrives, t1, w.a);
        }
        uint160 dF;
        {
            (uint160 sdF, uint160 saF) = _finals(m, defDrives);
            dF = _clamp(defDrives ? sdF : saF);
        }
        // Only a concentrated sink reads the limit, and a route's hops must find none. A
        // concentrated sink whose liquidity runs out before the meeting price takes only what it
        // holds.
        uint8 sinkKind = defDrives ? alt.kind : def.kind;
        if (sinkKind == ROUTE) {
            _setSinkLimit(0);
        } else if (_canWalk(sinkKind)) {
            _setSinkLimit(_gapPast(m, defDrives));
            uint160 cliff = DepthRecord.cliffOf(defDrives ? w.a : w.d);
            if (cliff != 0) dF = _capped((def.tax | alt.tax) != 0, t0, t1, m, defDrives, dF, cliff, w);
        }
        return (dF, defDrives ? m.sd : m.sa, defDrives);
    }

    // The driver's final `dF`, capped where the sink's walk ran dry (_capAtCliff), by what the
    // sink trades as the payout has it (_payout, read only for a sink with a cliff). Such a sink
    // is concentrated, never a stableswap, so only a transfer tax keeps it exact in. `w` holds the
    // sink's walk's record and the driver's (none for a V2 pair).
    function _capped(bool taxed, address t0, address t1, MeetIn memory m, bool defDrives, uint160 dF, uint160 cliff, Walks memory w)
        private
        view
        returns (uint160)
    {
        (, bool exactOut,) = _payout(t0, t1, defDrives ? m.sd > m.sa : m.sa > m.sd, taxed);
        return _capAtCliff(m, defDrives, dF, cliff, exactOut, w);
    }

    // The driver's final `dF`, or nearer its price when the sink would cross `cliff` (token space),
    // where its walk ran dry. Exact in, the sink takes the drive's whole output; exact out, it pays
    // back the drive's input. Either way one token flows between the two, token1 when the driver
    // moves down exact in or up exact out, else token0, and the cap is the final at which the
    // driver's flow is what the sink trades up to its cliff, span by span along the sink's own
    // record (V4Depth.tradedToCliff: a mean depth over-reads a sink that thins toward its cliff),
    // grossed up by the sink's fee for what it takes (its folded multiplier, a tax included) and
    // by the driver's for what the driver is owed. A cliff the sink cannot reach between the two
    // prices caps nothing, nor one of a sink over 2^64 times deeper than the driver (where the
    // arithmetic would overflow).
    function _capAtCliff(MeetIn memory m, bool defDrives, uint160 dF, uint160 cliff, bool exactOut, Walks memory w)
        private
        view
        returns (uint160)
    {
        (uint256 d, uint256 ld, uint256 s, uint256 ls) =
            defDrives ? (uint256(m.sd), m.ld, uint256(m.sa), m.la) : (uint256(m.sa), m.la, uint256(m.sd), m.ld);
        if (ld == 0 || ls > ld << 64) return dF;
        // A sink sitting on its cliff takes nothing: no restore.
        if (cliff == s) return uint160(d);
        bool down = d > s;
        if (down ? (cliff < s || cliff >= d) : (cliff > s || cliff <= d)) return dF;
        bool one = down != exactOut;
        uint256 c = V4Depth.tradedToCliff(defDrives ? w.a : w.d, one);
        c = _feeScaled(m, defDrives, exactOut, c);
        return _driverFinal(defDrives ? w.d : w.a, dF, d, ld, s, c, down, one);
    }

    // `c` scaled by the fee that counts: the sink's den/num exact in, the driver's num/den exact out.
    function _feeScaled(MeetIn memory m, bool defDrives, bool exactOut, uint256 c) private pure returns (uint256) {
        (uint256 n, uint256 q) = defDrives == exactOut ? (m.nd, m.dd) : (m.na, m.da);
        return exactOut ? FixedPointMathLib.fullMulDiv(c, n, q) : FixedPointMathLib.fullMulDiv(c, q, n);
    }

    // The driver's final as _finalAt has it, but where the driver's walk left a record, along its
    // way span by span, each at the depth the walk read there (V4Depth.priceAfter): a driver deep
    // only near its price trades `c` sooner than its mean depth says, one deep only in a sliver
    // there later. A way that runs out of liquidity before it trades `c` caps nothing.
    function _driverFinal(bytes memory rec, uint160 dF, uint256 d, uint256 ld, uint256 s, uint256 c, bool down, bool one)
        private
        view
        returns (uint160)
    {
        if (rec.length != 0) {
            (uint160 p, bool ok) = V4Depth.priceAfter(rec, c, one);
            if (ok) return p == 0 ? dF : (down ? (p > dF ? p : dF) : (p < dF ? p : dF));
        }
        return _finalAt(dF, d, ld, s, c, down, one);
    }

    // The final of a driver at sqrt price `d` of depth `ld`, moving `down` or up toward the sink at
    // `s`, whose flow is `c` wei of token1 (`one`) or token0, or `dF` when that is nearer `d`.
    // Rounded toward `d`.
    function _finalAt(uint160 dF, uint256 d, uint256 ld, uint256 s, uint256 c, bool down, bool one)
        private
        pure
        returns (uint160)
    {
        if (one) {
            uint256 delta = FixedPointMathLib.fullMulDiv(c, Q96, ld);
            if (!down) return d + delta < dF ? uint160(d + delta) : dF;
            if (delta >= d - s) return dF;
            return d - delta > dF ? uint160(d - delta) : dF;
        }
        // 1/final = 1/d -+ c / (L_d * 2^96)
        uint256 t = FixedPointMathLib.fullMulDiv(c, d, Q96);
        if (down) {
            uint256 capped = FixedPointMathLib.fullMulDivUp(d, ld, ld + t);
            return capped > dF ? uint160(capped) : dF;
        }
        if (t >= ld) return dF;
        uint256 up = FixedPointMathLib.fullMulDiv(d, ld, ld - t);
        return up < dF ? uint160(up) : dF;
    }

    // One full gap past the driver's price, seen from the sink: driver^2 / sink, in sqrt price.
    function _gapPast(MeetIn memory m, bool defDrives) private pure returns (uint160) {
        (uint256 d, uint256 s) = defDrives ? (uint256(m.sd), uint256(m.sa)) : (uint256(m.sa), uint256(m.sd));
        uint256 x = FixedPointMathLib.fullMulDiv(d, d, s);
        return x > MAX_SQRT ? MAX_SQRT : _clamp(uint160(x));
    }

    // Both legs' final prices (defended, alt). MeetingPrice.meetAt solves the optimum where
    // its first pool's output is sunk in full into the second and the profit is left in
    // the first pool's input token, which is how a drive executes, so the driver goes
    // first: an alt that drives is sized as such, not as the defended pool's sink.
    function _finals(MeetIn memory m, bool defDrives) private pure returns (uint160 sdF, uint160 saF) {
        if (defDrives) return MeetingPrice.meetAt(m.sd, m.ld, m.sa, m.la, m.na, m.da, m.g);
        (saF, sdF) = MeetingPrice.meetAt(m.sa, m.la, m.sd, m.ld, m.nd, m.dd, m.g);
    }

    // The driver's current price as both target and current: _restore reads that as NO_ARB.
    function _live(MeetIn memory m, bool defDrives) private pure returns (uint160, uint160, bool) {
        uint160 s = defDrives ? m.sd : m.sa;
        return (s, s, defDrives);
    }

    // A pair whose token T takes a fee on transfer (some pool states a tax on it). The
    // restore moves T from the pool that sells it cheap to the one that buys it dear, so
    // drive the pool T flows out of: VanHelsing then only ever spends the T it received
    // and repays the driver in the untaxed token, never owing an exact amount of T. T
    // keeps (1 - taxOut) leaving the driver and (1 - taxIn) entering the sink, which in
    // the meeting-price balance is exactly a fee on the sink's input, so it folds into the
    // sink's fee multiplier and everything downstream (the wedge, both passes) accounts
    // for it. Down-restore (sd >= sa): the defended pool outputs token1 and the alt token0;
    // up-restore the reverse. Both tokens taxed is not supported.
    function _taxFold(uint64 defTax, uint64 altTax, MeetIn memory m) private pure returns (bool defDrives) {
        uint64 any = defTax | altTax;
        bool t1 = any & 0xffffffff != 0; // token1's taxIn1 | taxOut1 are the low 32 bits
        require(!t1 || any >> 32 == 0, "TAXED_PAIR");
        defDrives = t1 == (m.sd >= m.sa);
        (uint64 drv, uint64 snk) = (altTax, defTax);
        if (defDrives) (drv, snk) = (defTax, altTax);
        uint256 shift = t1 ? 0 : 32; // T's taxOut at `shift`, its taxIn 16 bits above
        uint256 keep = (TAX_ONE - (drv >> shift & 0xffff)) * (TAX_ONE - (snk >> (shift + 16) & 0xffff));
        if (defDrives) {
            m.na = m.na * keep / TAX_ONE;
            m.da *= TAX_ONE;
        } else {
            m.nd = m.nd * keep / TAX_ONE;
            m.dd *= TAX_ONE;
        }
    }

    // One leg's sizing-effective liquidity: a stableswap's tangent depth capped by what it can
    // pay over the restore (CurveLib.depth), the walked depth for the others, `dry` for the sink.
    // Consolidated into one helper so _meet's call sites stay within the stack limit.
    function _legLiq(IPoolRegistry.Pool memory p, uint256 l, uint160 sOwn, uint160 sOther, address t0, address t1, bool dry)
        private
        view
        returns (uint256, bytes memory r)
    {
        if (_isStable(p.kind)) return (CurveLib.depth(p.kind, _addr(p.id), t0, t1, sOwn, sOther), r);
        return _walkLiq(p, l, sOther, t1, dry);
    }

    // Pass 2 for a concentrated leg: its depth toward its own pass-1 meeting price `sOwnFinal`
    // (the shorter segment the restore really trades through), combined with its pass-1 depth
    // `l1` by the leg's role, to guard against that leg's own failure:
    //   - The driver (`isDriver`) keeps the deeper, max(l1, l2): never re-walk it DOWN. A
    //     driver that is deep near its price and thin farther out reads deeper over the
    //     shorter segment (l2 > l1), and that depth is what the drive trades through; a driver
    //     that barely moves reads its own thin active range (l2 << l1), and keeping l1 avoids
    //     sizing to it.
    //   - The sink keeps the shallower, min(l1, l2): a walk to the other pool's price can count
    //     liquidity past a cliff the restore never reaches, so the shorter segment's read is
    //     the conservative one. But a sink that reads none at all over it sits in a gap of its
    //     liquidity, and a zero depth is what the meeting price restores to in full: it keeps
    //     l1, which counts the liquidity past the gap.
    // A concentrated sink can still absorb less than either read says, when its liquidity ends
    // at a hard bound inside the segment: the ward then captures less or does nothing. A leg
    // that is not concentrated (a V2 pair, whose depth is exact; a stableswap, already capped
    // by CurveLib.depth; a route) passes `l1` through. Both reads saturate rather than revert,
    // and the two are only compared, never multiplied.
    //
    // The pass-2 walk is replayed from the pass-1 walk's record (DepthRecord): on the same
    // state and toward the leg's own meeting price, between its price and the other pool's, it
    // takes the pass-1 walk's first steps, so the record gives the same depth without reading
    // the pool again. A walk the record does not cover is walked.
    function _pass2(IPoolRegistry.Pool memory p, uint256 l1, uint160 sOwnFinal, bool isDriver, address t1, bytes memory r)
        private
        view
        returns (uint256)
    {
        if (!_canWalk(p.kind)) return l1;
        (uint256 l2, bool replayed) = p.kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA ? V3Depth.replay(r, sOwnFinal) : V4Depth.replay(r, sOwnFinal);
        if (!replayed) (l2,) = _walkLiq(p, l1, sOwnFinal, t1, false);
        return isDriver ? (l1 > l2 ? l1 : l2) : (l2 == 0 || l1 < l2 ? l1 : l2);
    }

    // Concentrated kinds, whose depth is a tick walk (so re-walking at the leg's own meeting
    // price is meaningful). A V2 pair is a constant-L full-range position; a stableswap has no
    // ticks; a route keeps its pass-1 depth.
    function _canWalk(uint8 kind) private pure returns (bool) {
        return kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA || kind == UNIV4 || kind == INFI;
    }

    // Normalize a pool to (sqrtPriceX96, liquidity, feeNum, feeDen), reading only what the
    // fee check needs before sizing. A concentrated leg's liquidity is its depth walk's
    // (_walkLiq), so none is read here. V2 derives both from the reserves, sqrtP =
    // sqrt(r1/r0)*2^96 and L = sqrt(r0*r1) (a V2 pool is a constant-L full-range position, so
    // the mapping is exact), and returns r0*r1 for L: sizing takes the root (_walkLiq).
    function _normalize(IPoolRegistry.Pool memory leg, address t0, address t1)
        private
        view
        returns (uint160 s, uint256 l, uint256 fn, uint256 fd)
    {
        (bytes32 id, uint8 kind) = (leg.id, leg.kind);
        (fn, fd) = _feeMul(kind, leg.fee);
        if (kind == V3) {
            s = _clamp(V3Lib.price(_addr(id)));
        } else if (kind == V2) {
            (uint256 r0, uint256 r1) = V2Lib.getReserves(_addr(id));
            require(r0 > 0 && r1 > 0, "POOL_EMPTY");
            // sqrt(r1/r0)*2^96. The exact form's intermediate r1*2^192/r0 needs
            // r1/r0 <= uint64.max to fit uint256 (fullMulDiv reverts past it); beyond it,
            // the roots are taken first, less exact (each is floored) but only on a pool
            // this lopsided, and the read stays alive.
            if (r1 / r0 <= type(uint64).max) {
                s = _clamp(uint160(FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(r1, 1 << 192, r0))));
            } else {
                uint256 p = FixedPointMathLib.fullMulDiv(FixedPointMathLib.sqrt(r1), 1 << 96, FixedPointMathLib.sqrt(r0));
                s = _clamp(p > type(uint160).max ? type(uint160).max : uint160(p));
            }
            l = r0 * r1;
        } else if (kind == UNIV4 || kind == INFI) {
            s = _single(leg, t1);
        } else if (kind == ROUTE) {
            // A 2-hop route composed into one virtual pool; its fee multiplier is the product
            // of the hops', so take (fn, fd) from RouteLib rather than from its entry.
            (s, l, fn, fd) = RouteLib.normalize(REGISTRY, id);
            s = _clamp(s);
        } else if (kind == RIALTO || kind == TESSERA) {
            // A market: its mid and the fee multiplier its bid and ask make, from its own quotes,
            // in place of its entry's fee; its depth is sizing's (_legLiq).
            (s, fn, fd) = CurveLib.marketPrice(kind, _addr(id), t0, t1);
            s = _clamp(s);
        } else if (Chain.ALGEBRA != 0 && kind == ALGEBRA) {
            // Its fee is the larger of its entry's and the one its plugin last set, which moves.
            uint256 live;
            (s, live) = V3Lib.algebraState(_addr(id));
            s = _clamp(s);
            if (live > leg.fee) (fn, fd) = (1e6 - live, 1e6);
        } else {
            // Stableswap (CURVE/STABLE): its get_dy price; its depth is sizing's (_legLiq).
            s = _clamp(CurveLib.price(kind, _addr(id), t0));
        }
    }

    // A singleton pool's price, straight from its manager's storage by its id (the poolId); a
    // flipped pool's price is the inverse.
    function _single(IPoolRegistry.Pool memory p, address t1) private view returns (uint160 s) {
        s = p.kind == UNIV4
            ? uint160(V4Config.load(address(UniV4Lib.POOL_MANAGER), V4Config.mapSlot(p.id, V4Config.UNI_POOLS)))
            : uint160(V4Config.load(address(InfinityLib.CL), V4Config.mapSlot(p.id, V4Config.CL_POOLS)));
        if (_flipped(p.shape, t1)) s = V4Config.invertSqrt(s);
        s = _clamp(s);
    }

    // Whether a singleton pool's currency order is the reverse of its pair's tokens: only a
    // pool whose currency0 is native can be, and only on a pair whose token1 is the wrapped
    // native currency, which stands for it (native sorts first in the pool, its wrapped token
    // last in that pair).
    function _flipped(uint32 shape, address t1) private pure returns (bool) {
        return shape & NATIVE != 0 && t1 == V4Config.WRAPPED_NATIVE;
    }

    // Effective liquidity over the restore range: a concentrated leg walks its ticks toward
    // the other pool's price and also returns the walk's record (DepthRecord); a V2 leg's
    // constant L is exact, the root of the reserves' product normalize left in spotL; a
    // route's is RouteLib's.
    function _walkLiq(IPoolRegistry.Pool memory p, uint256 spotL, uint160 otherSqrtP, address t1, bool dry)
        private
        view
        returns (uint256, bytes memory r)
    {
        uint8 kind = p.kind;
        if (kind == V2) return (FixedPointMathLib.sqrt(spotL), r);
        if (kind == V3) return V3Depth.effectiveLiquidity(_addr(p.id), otherSqrtP, MAX_DEPTH_TICKS, dry);
        // V4Depth reads Uniswap V4 or Pancake Infinity CL by kind, the tick spacing the shape's.
        if (kind == UNIV4 || kind == INFI) {
            return V4Depth.effectiveLiquidity(kind, p.id, int24(uint24(p.shape)), _flipped(p.shape, t1), otherSqrtP, MAX_DEPTH_TICKS, dry);
        }
        if (kind == ROUTE) return (RouteLib.effectiveLiquidity(REGISTRY, p.id, otherSqrtP, MAX_DEPTH_TICKS), r);
        if (Chain.ALGEBRA != 0 && kind == ALGEBRA) return V3Depth.effectiveLiquidityList(_addr(p.id), otherSqrtP, MAX_DEPTH_TICKS, dry);
        return (spotL, r);
    }

    // (1 - fee) as num/den for the pool's protocol: a V2 family fee is over 1e4, a
    // V3 or V4 fee over 1e6, a stableswap fee over 1e10.
    function _feeMul(uint8 kind, uint32 fee) private pure returns (uint256 num, uint256 den) {
        den = (kind >> Chain.ALGEBRA == V3 >> Chain.ALGEBRA || kind == UNIV4 || kind == INFI) ? 1e6 : (_isStable(kind) ? 1e10 : 1e4);
        num = den - fee;
    }

    // Payout policy: read both tokens' packed (priority, minProfit) once, pick the
    // blue chip (higher priority), and derive the profit token `base`, whether the
    // sink sale is exact-output, and the base token's dust `floor`. got = zeroForOne
    // ? t1 : t0; exact output profits in got, exact input in the owed token. No
    // preference (both priorities 0) keeps exact-input.
    function _payout(address t0, address t1, bool zeroForOne, bool inOnly)
        private
        view
        returns (address base, bool exactOut, uint256 floor)
    {
        (uint128 p0, uint128 m0, uint128 p1, uint128 m1) = REGISTRY.tokenInfos(t0, t1);
        address want = (p0 == 0 && p1 == 0) ? address(0) : (p1 > p0 ? t1 : t0);
        // exact-out steers profit into `got`; an `inOnly` sale (a stableswap sink, or a
        // taxed pair) cannot honor a blue-chip preference toward `got`.
        exactOut = !inOnly && want == (zeroForOne ? t1 : t0);
        base = (zeroForOne == exactOut) ? t1 : t0;
        floor = base == t0 ? m0 : m1;
    }

    function _clamp(uint160 p) private pure returns (uint160) {
        if (p < MIN_SQRT) return MIN_SQRT;
        if (p > MAX_SQRT) return MAX_SQRT;
        return p;
    }

    // A V2/V3/stableswap pool's id is its address zero-padded to bytes32; recover it.
    function _addr(bytes32 id) private pure returns (address) {
        return address(uint160(uint256(id)));
    }

    // A singleton pool's config (V4Config's layout): its PoolKey, packed, handed straight to
    // the adapters, which read the fields they need in assembly; the core never decodes it.
    // Unpacked here as the registry's configOf unpacks it, from the pool's key word in the
    // registry (poolKeys, one slot, through the registry's read) and the kind and two tokens the
    // caller already holds; a config that does not pack comes from configOf.
    function _cfg(uint8 kind, bytes32 id, address a, address b) private view returns (bytes memory) {
        uint256 w = _poolKey(id);
        if (w == 0) return REGISTRY.configOf(id);
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        (address c0, address c1) = (w >> 208) & 1 != 0 ? (address(0), t0 == V4Config.WRAPPED_NATIVE ? t1 : t0) : (t0, t1);
        return abi.encodePacked(kind, c0, c1, uint24(w >> 160), uint24(w >> 184), address(uint160(w)), bytes32(w >> 216));
    }

    // poolKeys[id], through the registry's read.
    function _poolKey(bytes32 id) private view returns (uint256 w) {
        address registry = address(REGISTRY);
        uint256 slot = V4Config.mapSlot(id, REG_POOL_KEYS);
        assembly ("memory-safe") {
            mstore(0, 0xed2e5a97) // read(uint256)
            mstore(0x20, slot)
            if iszero(and(gt(returndatasize(), 0x1f), staticcall(gas(), registry, 0x1c, 0x24, 0, 0x20))) {
                revert(0, 0)
            }
            w := mload(0)
        }
    }

    function _setSinkLimit(uint160 limit) private {
        assembly { tstore(SINK_LIMIT_SLOT, limit) }
    }

    function _sinkLimit() private view returns (uint160 limit) {
        assembly { limit := tload(SINK_LIMIT_SLOT) }
    }

    // The sink's limit, or the extreme one in its direction when it has none (a route's hop).
    function _sinkLimitOr(bool zeroForOne) private view returns (uint160 limit) {
        limit = _sinkLimit();
        if (limit == 0) limit = zeroForOne ? V4Config.MIN_SQRT : V4Config.MAX_SQRT;
    }

    function _ctx() private view returns (uint256 v) {
        assembly { v := tload(CTX_SLOT) }
    }

    function _setCtx(uint256 mode, uint8 kind, address caller) private {
        uint256 v = (mode << 168) | (uint256(kind) << 160) | uint256(uint160(caller));
        assembly { tstore(CTX_SLOT, v) }
    }

    function _clearCtx() private {
        assembly { tstore(CTX_SLOT, 0) }
    }

    // Transient reentrancy guard. Clears to 0 after `_` on the success path so one
    // transaction can ward many times; on any revert between, EIP-1153 rolls the
    // write back to 0. A nested execute() during an in-flight one
    // reverts here with "REENTRANCY".
    modifier nonReentrant() {
        uint256 locked;
        assembly { locked := tload(LOCK_SLOT) }
        require(locked == 0, "REENTRANCY");
        assembly { tstore(LOCK_SLOT, 1) }
        _;
        assembly { tstore(LOCK_SLOT, 0) }
    }

    // The native currency, from a singleton's take or an unwrap. The adapters wrap what they take
    // and pass on what they unwrap at once, so none stays here.
    receive() external payable {}

    // Every V2 and V3 pool callback lands here (the singletons call unlockCallback and
    // lockAcquired). Authenticate msg.sender against the pinned caller, then route by mode:
    // pay a nested V3 sink, or sink the driven pool's output and repay it (V2 or V3, per the
    // pinned kind).
    fallback(bytes calldata data) external payable returns (bytes memory) {
        uint256 ctx = _ctx();
        require(ctx != 0 && msg.sender == address(uint160(ctx)), "BAD_CB");
        if ((ctx >> 168) == CB_SINK) return _onSink(data);
        return _onDrive(uint8((ctx >> 160) & 0xff), data);
    }
}
