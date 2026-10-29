# @nexroute/van-helsing

Van Helsing is an on-chain arbitrageur for swaps on any EVM chain, called inside your own transaction. One call,
`ward(id, payee)`, sent right before or right after a swap, brings pool `id` back to the price of its
anchor, the most liquid other pool of its pair, and pays the gap it closed to `payee`, less a 10% cut.
A ward before the swap undoes a front-run on that pool; a ward after it captures the back-run the swap
opens. A ward that fails never reverts the transaction it is in.

**You do not need this SDK.** When you know the pools your swap trades, build the `ward` calls
yourself, in any language: see [Without the SDK](#without-the-sdk).

**What it does:** it identifies the swaps in a transaction. Give it a transaction whose pools you do
not know (calldata from an aggregator's API, a user's swap, a signed transaction) and it simulates it,
finds every pool it trades, simulates a ward before and after each one, and returns the wards worth
their gas.

## Install

```sh
npm install @nexroute/van-helsing
```

It runs in your process, on viem, against any RPC that serves `eth_simulateV1`. Nothing is sent
anywhere else.

## Use

```js
import { planWards } from "@nexroute/van-helsing";

const { before, after } = await planWards(swapTx, { chainId: 56 });
// send [...before, swapTx, ...after] together, in that order, in one block
```

- `swapTx` is the swap as you would send it, unsigned: `{ from, to, data, value }`, with the fees you
  will send it at, since the wards are weighed at its gas price. A signed transaction, raw, works too.
- `before` and `after` are calls, `{ to, data }`, to Van Helsing.
- The bounties go to the swap's sender, unless you pass `{ payee }`.

The wards and the swap must land together, in order: in one transaction from an account that batches
calls (EIP-5792 `wallet_sendCalls`, or an EIP-7702 account), or as one private bundle
(`eth_sendBundle` to a builder such as Hades or BlockRazor). A ward sent on its own after a public swap
protects nothing: the sandwich already happened.

A swap that needs an approval or a wrap first reverts on its own until that call lands. Pass the calls
in the order they go out, and send the wards around all of them:

```js
const { before, after } = await planWards([approveTx, swapTx], { chainId: 56 });
// send [...before, approveTx, swapTx, ...after]
```

## How it decides

1. It simulates the transaction and reads its swap events: the pools it trades.
2. It simulates it again with a ward before and after each pool, and reads each ward's bounty from
   its `Captured` event.
3. It keeps every ward whose bounty, less the cut, is worth more than its gas. By default it also keeps
   wards that may capture nothing, as insurance against a front-run, while together they cost at most
   0.5% of what the swap is worth (`maxPremium`).

A ward on a pool Van Helsing cannot anchor never captures, so it is left out. A ward before the swap
undoes a front-run only on a pool Van Helsing can anchor: a token with a single pool has none, so send
its swap as a private bundle.

A ward that finds nothing costs about 40k gas inside another transaction, about 60k as a transaction of
its own. One that captures usually costs 250k to 600k. The bounties are estimates at the simulated
block: Van Helsing sizes each ward again when it runs, so it captures what is there, never more.

## Options

| Option | Default | |
|---|---|---|
| `chainId`, `chain` or `client` | one is required | `56` or `"bsc"` for a client on BNB Chain's public RPC, or a viem client on your own node, which must serve `eth_simulateV1` |
| `before`, `after` | `"affordable"` | which wards to keep on each side: `"affordable"` (those that pay, and insurance within `maxPremium`), `"profitable"` (only those that pay), `"always"` or `"never"` |
| `maxPremium` | `0.005` | the most the wards that may capture nothing may cost together, as a share of what the swap is worth |
| `minProfit` | `0n` | what a ward must net after its gas, in native wei, to count as paying |
| `maxWardGas` | `500000n` | a ward that captures nothing and would burn more gas than this is dropped |
| `payee` | the swap's sender | who receives the bounties |
| `gasPrice` | the swap's | the gas price the wards are sent and weighed at, when it is not the swap's |
| `block` | `"latest"` | the block the simulations build on |
| `value` | | `async (token, amount) => wei`, to price a token the SDK cannot |
| `overrides` | | `eth_simulateV1` state overrides, for a sender not funded yet |
| `vanHelsing` | the deployment | Van Helsing's address, on a chain the SDK has no deployment for |

A public RPC sees the unsigned swap before it is sent and limits how often it is asked (a plan makes
5 to 7 calls), so in production pass a `client` on your own node.

## Result

| Field | |
|---|---|
| `before`, `after` | the wards to send: calls `{ to, data }` to Van Helsing, with the pool's `id` and `kind` |
| `pools` | every pool the transaction trades, `{ kind, id }` |
| `bounties` | one entry per simulated ward: what it would capture (`token`, `amount`, the payee's `share`, `worthWei`), its gas (`gasUsed`, `costWei`), whether it is `kept`, and a `note` saying why |
| `payee`, `vanHelsing`, `gasPrice` | who is paid, the contract, and the gas price the wards were weighed at |
| `swapWorthWei` | what the swap is worth, in native wei, or `null` when the SDK cannot price what it moves |
| `reverted` | the transaction reverts in the simulation: there is nothing to ward |
| `beforeDropped` | set when the swap reverts behind the wards before it: they are left out, so the swap still goes |

## Without the SDK

```solidity
function ward(bytes32 id, address payee) external;
function ward(bytes32 id, address payee, uint256 maxGas) external;
event Captured(bytes32 indexed pool, bytes32 indexed anchor, address indexed payee, address token, uint256 bounty);
```

- Van Helsing's address on BNB Chain: `0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25`.
- `id`: the pool's address, zero-padded to 32 bytes, or, for a pool kept in a singleton pool manager,
  its pool id.
- `payee`: who receives the bounty, less the cut. The zero address pays whoever sends the call: through
  a router or a multicall contract, that contract.
- `maxGas`: optional, the most gas the attempt may use.

Send a ward right before and right after the swap, in the same transaction or bundle. To send only the
wards that pay, simulate them with the swap, with `eth_simulateV1` for example, and keep those whose
`Captured` bounty, less the cut, is worth more than their gas. The guides show each step in
JavaScript, Go and Rust: [vanhelsing.nexroute.io](https://vanhelsing.nexroute.io/integrate/reference.html).

## In a router

An aggregator puts `before` ahead of the route's first swap and `after` behind its last, as steps its
router runs, in the user's one transaction. A ward moves none of the router's tokens, and its failure
never reverts the route. Leave room in the route's gas limit: a ward before that meets a front-run uses
more gas than the plan simulated.

## Links

- Guides: [vanhelsing.nexroute.io](https://vanhelsing.nexroute.io)
- Source: [github.com/nexroute/van-helsing](https://github.com/nexroute/van-helsing)
- `npm test` runs the unit tests; `VH_LIVE_RPC=<rpc> node --test test/live.test.js` runs the live one.
