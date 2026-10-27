# Van Helsing

Van Helsing is an on-chain arbitrageur called inside your own transaction. Wards just before a
swap bring each pool it trades back in line with that pool's anchor, the most liquid other pool of
its pair, so the swap gets the fair price; a ward just after it captures the back-run the swap
opens. On a pool Van Helsing can anchor, a sandwich around a warded swap loses money, and 90% of
every bounty goes to the address the ward names. Van Helsing holds no funds, and its failure never
reverts the transaction it runs in.

Van Helsing sits behind a transparent proxy whose admin is the team's Safe, with no timelock, and
the registry it reads its pools from is written by an operator key the same Safe appoints.

The guides, for wallets, aggregators, exchanges, RPC providers, builders, AMMs and traders, are at
[vanhelsing.nexroute.io](https://vanhelsing.nexroute.io).

## Deployment

On BNB Chain, verified on BscScan:

- Van Helsing, the address to call:
  [`0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25`](https://bscscan.com/address/0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25).
- The implementation behind it today, which a router can call directly to keep exactly the code it
  reviewed, without following upgrades:
  [`0xe40bC8f5b571d1982822D625A726997A6e1B369a`](https://bscscan.com/address/0xe40bC8f5b571d1982822D625A726997A6e1B369a).

## What is here

- `contracts/`: Van Helsing (`VanHelsing.sol`), the pool registry it reads (`PoolRegistry.sol`),
  their libraries and interfaces, the pool probes Van Helsing's node simulates (`probe/`), and the
  test fixtures (`test/`).
- `ignition/`: the deployment: the registry, the libraries, and Van Helsing behind its proxy.
- `lib/`: the Hardhat configuration and the helpers the tests and the deployment share.
- `sdk/`: [`@nexroute/van-helsing`](sdk/README.md), which plans the wards around a swap, on npm at
  [npmjs.com/package/@nexroute/van-helsing](https://www.npmjs.com/package/@nexroute/van-helsing).
- `test/`: the contracts' tests.

## Build and test

```sh
npm ci
npx hardhat compile
VH_NO_FORK=1 npx hardhat test mocha   # the tests that need no fork of BNB Chain
npx hardhat test mocha                # all of them, on a fork: BSC_ARCHIVE_URL, or the public Blast archive
```

To test the SDK alone, run `npm ci && npm test` in `sdk/`.

## License

Van Helsing is under the Business Source License 1.1 (`LICENSE`): the licensor is Remora
Technologies Corp., and on 2030-10-22 it moves to GPL-2.0-or-later. The few lines adapted from
Uniswap v4-core keep Uniswap's MIT notice (`NOTICE`). The SDK (`sdk/`) is under MIT.

This repository is published from Van Helsing's development repository at each release.
