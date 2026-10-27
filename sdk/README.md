# @nexroute/van-helsing

Plan VanHelsing's protection of an unsigned swap: which pools it touches, and which
`ward(id, payee)` calls to send around it. The search happens here, off-chain, for free;
what goes on-chain is one bounded call per pool.

Guides: [vanhelsing.nexroute.io](https://vanhelsing.nexroute.io). Source: [github.com/nexroute/van-helsing](https://github.com/nexroute/van-helsing).

A ward restores a pool to the fair price, the price of its anchor (the most liquid other pool
of its pair), and pays the gap it closed as a bounty. Its failure never reverts the transaction it is in.

- A ward **before** the swap is insurance: it captures whatever a front-run, or any standing gap,
  left in the pool, so the swap trades at the fair price. When there is nothing to capture it
  costs a no-op's gas, about 55k to 60k per pool (about 95k for a stableswap pool).
- A ward **after** the swap captures the back-run the swap itself opens.

Each ward that captures something emits `Captured` and pays its bounty to `payee`, less VanHelsing's
10% cut. `planWards` sets `payee` to the swap's own sender (`tx.from`); pass `{ payee }` to pay someone
else.

viem-only. Requires an RPC that supports `eth_simulateV1` (Geth/Reth/Erigon): pass a `chainId`
or a `chain` slug for a default client on a public RPC, or a viem `client` on your own node (see
[Clients](#clients)).

## planWards

```js
const { before, after } = await planWards(swapTx, { chainId: 56 });
// submit [...before, swapTx, ...after] as one atomic bundle
```

A swap that needs another call first, the approval of the token it pays or the wrap of the
native token, reverts on its own until that call lands, and a plan of it finds no pool. Pass the
calls in the order they go out, from one sender, and send the wards around all of them:

```js
const { before, after } = await planWards([approveTx, swapTx], { chainId: 56 });
// submit [...before, approveTx, swapTx, ...after]
```

A signed transaction, as an RPC receives it, raw, is planned as it is: `planWards(rawTx, ...)`
decodes it, recovers its sender from its signature and keeps its fees. One signed for another
chain than the plan's is refused.

`planWards` simulates the swap alone to find its pools and what it moves, then once more with
its wards on both sides, and reads each ward's bounty off its `Captured` event. It weighs the
payee's share of each bounty against that ward's own gas, at the swap's gas price. A ward
is profitable when that share is worth more than its gas. The wards after are weighed on the
bundle that is sent: the swap behind only the wards before that are kept, so a gap a dropped
ward before leaves in the pool counts in what the wards after capture.

By default both legs are "affordable": a ward that is profitable is kept, and the wards that
may capture nothing are kept while, together, their gas costs at most `maxPremium`, 0.5%, of
what the swap is worth. Before the swap they insure it against a front-run; after it they capture
a back-run the market may open by the time the swap lands. The wards before come first, and the
wards after get what is left of the 0.5%. The swap is worth the most of one token its sender
pays or receives, over every leg of the route and net of refunds, priced in the native token
(or, when that cannot be priced, the largest amount of a token the swap moves). Of the 2,704
sandwiches the node measured on BNB Chain from October 19 to 22, 2026, the median victim lost
1.06% of its swap, so 0.5% stays well under what an attack takes. A swap the SDK cannot value
keeps no such ward, and the plan says so.

It prices each chain's hub tokens, each with its own decimals on that chain:

- BNB Chain: WBNB one for one; USDT, USDC, BUSD, U, USD1 and FDUSD at a dollar through the
  Chainlink BNB/USD feed; ETH through Chainlink's ETH/USD feed.
- Ethereum: WETH one for one; USDC and USDT (6 decimals), DAI, USD1 and FDUSD at a dollar
  through the Chainlink ETH/USD feed.

The feeds are read in the same simulation as the wards. Pass `value` to price anything else.

A ward on a pool Van Helsing cannot anchor can never capture: `planWards` leaves it out,
whatever the policy.

Each ward restores its pool against its anchor, the most liquid other pool of its pair: the
contract always takes that pool, so there is nothing to choose. Every simulation of one
`planWards` call builds on the same block, and simulates the
block after it, stamped as the chain stamps its next one: a second later on BNB Chain, which
makes a block every 0.45 s, and 12 s later on Ethereum. A node left to itself stamps it 12 s
later on every chain, and on BNB Chain a swap whose deadline or quote runs out sooner would
revert there.

| Option | Default | |
|---|---|---|
| `client`, `chain` or `chainId` | one is required | a viem client whose RPC serves `eth_simulateV1`, or `"bsc"` or `"ethereum"`, or chain id `56` or `1`, for that chain's default client |
| `before` | `"affordable"` | the wards before the swap: `"affordable"` (those that are profitable, and the rest as insurance while within `maxPremium`), `"profitable"` (only those that capture a standing gap worth more than their gas), `"always"` or `"never"` |
| `after` | `"affordable"` | the wards after the swap: `"affordable"` (those that are profitable, and the rest while within what `maxPremium` leaves), `"profitable"` (only those worth more than their gas), `"always"` or `"never"` |
| `maxPremium` | `0.005` | the most the wards that may capture nothing may cost, before and after together, as a share of what the swap is worth |
| `minProfit` | `0n` | what a ward must net after its gas, in native wei, to count as profitable |
| `maxWardGas` | `500000` | a ward that captures nothing and would burn more gas than this is dropped, whatever the policy |
| `block` | the current block | the block every simulation builds on |
| `payee` | the swap's sender | who receives the bounties |
| `gasPrice` | the swap's | wei per gas the wards are sent, simulated and weighed at, when it is not the swap's |
| `value` | | `async (token, amount) => wei of native token`, or `null` for no price: prices the tokens the SDK cannot. `token` comes checksummed; a bigint or a number is taken as wei. Return `undefined` to fall back to the built-in prices. |
| `vanHelsing` | from `deployments.js` | the VanHelsing address |
| `overrides` | | `eth_simulateV1` state overrides, so a swapper not yet funded still simulates |

Which wards to send is the integrator's call: the policies only say what `planWards` keeps.

The wards go out with the swap, in its transaction or its bundle, so they are weighed at its gas
price: its `gasPrice`, or for an EIP-1559 swap the next block's base fee plus its
`maxPriorityFeePerGas`, at most its `maxFeePerGas`. Pass the swap with the fees it will be sent
at. A tip it leaves out is the node's suggested one, as viem would set it: the chain's regular
price, 0.05 gwei on BNB Chain. That suggestion is a setting of each node, its miner gas price, so
on your own node check it, or pass the fees.

Every call the plan sends runs at that price in its simulations, as the chain charges it, within
2^24 gas, the most one transaction may use on Ethereum, or the call's own limit when higher. A
contract can read the price its transaction pays, so a simulation at 0 is not the chain the swap
goes to. The swap's own limit is left to its sender: estimated for one state, it can fall short
on another. The node takes each call's gas limit at that price from its sender before running it:
the plan adds that gas to the sender's balance, in the simulation only, so the sender keeps what
it holds for its calls. A swap that names no sender has nobody to pay its gas, and runs at 0.

It returns `{ pools, before, after, bounties, payee, vanHelsing, reverted, gasPrice, swapWorthWei }`:

- `pools`: `[{ kind, id }]`: each pool's protocol, as a number, and its `ward` id:
  its address padded to bytes32, or, for a pool kept in a singleton pool manager, its pool id.
- `before`, `after`: the wards, as calls `{ to, data }` to Van Helsing, with the pool's `id` and
  `kind` beside them. A call is not a transaction: a wallet sends it with the swap in one batch
  (EIP-5792 `wallet_sendCalls`), a bundle signs it into a transaction, a router runs it as a step
  of the route, and a contract calls `ward(id, payee)` with its `id`.
- `bounties`: one entry per simulated ward, `{ leg, id, anchor, token, amount, share,
  worthWei, gasUsed, costWei, kept, note }`. `leg` is `"before"` or `"after"`, `anchor` the
  pool the restore was made against, `amount` the whole bounty, `share` the payee's, and
  `note` says why it was kept or dropped: `worth 22607.3x its gas`, `nothing to capture`,
  `worth less than its gas`, `nets less than minProfit after its gas`,
  `insurance: 0.012% of the swap`, `insurance would cost 1.900% of the swap, more than maxPremium
  allows`, `affordable: 0.003% of the swap, with the insurance before it`, `VanHelsing does not list this pool, so its ward captures nothing`,
  `no price for 0x...: pass value to weigh it`.
- `swapWorthWei`: what the swap was valued at, in native wei, or `null` when it moves nothing
  the SDK can price.
- `beforeDropped`: set when the swap reverts once the wards before it run. A ward before that
  captures a gap in the swap's favor is kept, and pays that gap to `payee`: only when the swap then
  reverts, its quote counting on the gap, is it left out, so the swap still goes. The wards
  before that capture nothing stay, since they leave the swap's price alone and can still undo a
  front-run.

The bounties are estimates at the latest block. VanHelsing re-sizes every ward when it runs,
so if the pools have moved since, a ward captures less, never more than is there.

A live run (`test/live.test.js`) on BNB Chain, with VanHelsing injected into the simulation
for PancakeSwap's USDT/WBNB pools: a 300 BNB swap through the V2 router
left a back-run on the V2 pair. Warded after the swap against its anchor, the V3 0.05% pool,
it captured 1.070 WBNB for 533k gas. The ward before the swap captured nothing for 58k gas.
The same run plans a swap of WBNB that must be wrapped and approved first, with those two
calls, and a swap due within 3 seconds.

## Example: a PancakeSwap Infinity swap

Build the Infinity swap with PancakeSwap's routing SDK (the Universal Router calldata
encodes the V4 swap actions and PoolKeys, which is exactly why you cannot see the pools
yourself), then plan its wards.

```js
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SmartRouter } from "@pancakeswap/smart-router";
import { PancakeSwapUniversalRouter } from "@pancakeswap/universal-router-sdk";
import { planWards } from "@nexroute/van-helsing";

const client = createPublicClient({ chain: bsc, transport: http(RPC_URL) });
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: bsc, transport: http(RPC_URL) });

// 1. Build, but do NOT broadcast, the PancakeSwap Infinity swap. Broadcasting it into the
//    public mempool is exactly what exposes it to a sandwich.
const trade = await SmartRouter.getBestTrade(amountIn, tokenOut, TradeType.EXACT_INPUT, poolOptions);
const { to, value, calldata } = PancakeSwapUniversalRouter.swapCallParameters(trade, { recipient: account.address });
// with the fees it is sent at, which the wards are weighed at
const swapTx = { to, from: account.address, value, data: calldata, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIO };

// 2. Plan its protection: wards before and after it, bounties to account.address.
const { before, after } = await planWards(swapTx, { chainId: 56 });
```

The wards before, the swap and the wards after MUST land together, in that order, in the same
block. A public swap followed by separate ward transactions is NOT protected: the sandwich
already happened. Send them in one transaction from your account when it batches calls, or
else as one private bundle.

### Option A: one transaction from your account

Under EIP-7702 your account runs an account contract's code, so it makes the three calls itself,
in one transaction. The atomicity is on-chain. In the public mempool, each ward before the swap
undoes a front-run on its pool. A token with a single pool gets no ward, so send its swap as a
private bundle (Option B). This delegates once to
`Simple7702Account`, eth-infinitism's EIP-7702 account and viem's default, at the same address
with the same code on BNB Chain and Ethereum, which runs calls only for the account itself.

```js
const SIMPLE_7702 = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const BATCH = parseAbi([
    "struct Call { address target; uint256 value; bytes data; }",
    "function executeBatch(Call[] calls)",
]);

// once: the account runs Simple7702Account's code
const authorization = await walletClient.signAuthorization({ contractAddress: SIMPLE_7702, executor: "self" });
await walletClient.sendTransaction({ to: account.address, authorizationList: [authorization] });

// each swap: the account calls itself and runs the three calls in order, or none of them
const calls = [...before, swapTx, ...after].map(({ to, data, value = 0n }) => ({ target: to, value, data }));
await walletClient.writeContract({ address: account.address, abi: BATCH, functionName: "executeBatch", args: [calls] });
```

### Option B: private bundle

Sign `[...before, swapTx, ...after]` as separate transactions with consecutive nonces, then send
them as one all-or-nothing bundle, here to [Hades](https://docs.hades.build/bundles), on BNB Chain,
with the key from its partner panel; BlockRazor takes the same `eth_sendBundle` call. The swap never
touches the public mempool, and the builder keeps the order.

```js
// Submit signed raw txs as an all-or-nothing bundle to Hades.
async function sendBundle(txs) {
    const res = await fetch("https://rpc.hades.build", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${HADES_KEY}` },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_sendBundle",
            params: [{ txs }],
        }),
    });
    const { result, error } = await res.json();
    if (error) throw new Error(`eth_sendBundle: ${error.message}`);
    return result; // bundle hash
}

const nonce = await client.getTransactionCount({ address: account.address });
const signed = await Promise.all([...before, swapTx, ...after].map((call, i) =>
    account.signTransaction({ ...call, chainId: bsc.id, nonce: nonce + i, gas: GAS, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIO }),
));
await sendBundle(signed);
```

A ward on a pool Van Helsing cannot anchor is a safe no-op. A swap that needs an approval
first is planned with it, `planWards([approveTx, swapTx], ...)`, and the wards go around both.
If the swapper is not yet funded, pass `overrides` so the simulation still executes and emits
its Swap events, for example
`planWards(swapTx, { chainId: 56, overrides: { [account.address]: { balance: "0x56bc75e2d63100000" } } })`.

`planWards` resolves the VanHelsing address from the client's chain (see `src/deployments.js`):
on BNB Chain, `0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25`. On any other chain, pass `{ vanHelsing: "0x..." }`.

## Clients

`planWards` takes the slug or the chain id of a chain the SDK has a default client for, or a viem
client whose RPC serves `eth_simulateV1` with state overrides and traced transfers:

| `chain` | `chainId` | Default RPC |
|---|---|---|
| `"bsc"` | `56` | `https://bsc-dataseed.bnbchain.org`, BNB Chain's own |
| `"ethereum"` | `1` | `https://ethereum-rpc.publicnode.com` |

A client on another chain than the `chain` or `chainId` passed with it is an error, and so are a
`chain` and a `chainId` that disagree. A public RPC sees the unsigned swap before it is sent and
limits how often it is asked (one plan makes 5 to 7 calls), so a wallet or a router in production
passes a client on its own node.

## For a router: wards as steps of the route

An aggregator whose router runs a route as a list of calls, a swap facet's steps for example,
puts the plan's wards in that list: `before` ahead of the route's first swap, `after` behind its
last. Each ward is one call, `{ to, data }`, to Van Helsing: its failure never reverts the route,
and it moves none of the router's tokens, so the route runs as it would without it, in the
user's one transaction. The router allows Van Helsing's `ward` among the calls it runs. Leave
room in the route's gas limit: a ward before that meets a front-run uses more gas than the plan
simulated.

## Tests

`npm test` runs the unit tests. `VH_LIVE_RPC=<rpc> node --test test/live.test.js` also runs the
live one, against any RPC that serves `eth_simulateV1` with state overrides.
