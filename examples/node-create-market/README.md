# Node Create-Market Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> A backend script that builds a perp market from a creation intent and registers
> it, with `@openperps/sdk`. No UI.

This example shows the SDK-only path: a Node script composes the market creation
instructions, registers the resulting config, and prints the derived addresses.
The script lives in [`src/index.ts`](src/index.ts).

<!-- Add a short terminal recording of the printed plan and addresses here, for
     example ../../.github/assets/node-create-market-demo.gif -->

## What it demonstrates

- Build a market from an `OpenPerpsMarketCreationIntent`.
- Register the resulting config in a local JSON registry.
- Print the creation plan and the derived market, vault, and House addresses.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then run this example
cd examples/node-create-market
npm install
npm start
```

By default the script builds and registers without sending, so it runs without a
funded key (it only reads the rent figure from the RPC) and writes `registry.json`.
Set `OPENPERPS_RPC` and `OPENPERPS_PROGRAM_ID` to point at your deployment.

To create the market on-chain, fund the authority, supply a real quote (USDC)
mint, and sign and send `build.instructions` with `[authority, market]`.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
