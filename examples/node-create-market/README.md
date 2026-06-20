# Node Create-Market Example

A backend script that builds a perp market from a creation intent and registers it, with `@opp-oss/sdk`. No UI.

This example shows the SDK-only path: a Node script composes the market creation instructions, registers the resulting config, and prints the derived addresses. The script lives in `src/index.ts`.

## What It Demonstrates

- Build a market from an `OpenPerpsMarketCreationIntent`.
- Register the resulting config in a local JSON registry.
- Print the creation plan and the derived market, vault, and liquidity-vault addresses.

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

By default the script builds and registers without sending, so it runs without a funded key (it only reads the rent figure from the RPC) and writes `registry.json`. Set `OPENPERPS_RPC` and `OPENPERPS_PROGRAM_ID` to point at your deployment.

To create the market on-chain, fund the authority, supply a real quote (USDC) mint, and sign and send `build.instructions` with `[authority, market]`.

## How It Works

`src/index.ts` builds the market with `@opp-oss/sdk`, derives the market, vault, and liquidity-vault addresses, and writes them to `registry.json`. Point a keeper at that registry to run the market.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@opp-oss/sdk`](../../packages/sdk/README.md)
