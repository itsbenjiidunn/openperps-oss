# DEX Terminal Example

A trading terminal that adds perp trading with `@openperps/react` and `@openperps/sdk`.

This example shows how a DEX terminal can place a long/short panel next to a chart using OpenPerps React widgets. The core integration lives in `src/App.tsx`.

## What It Demonstrates

- Load a market registry and filter the market list.
- Select a market and open its detail view.
- Render a price chart with `<OpenPerpsChart/>` from candle data.
- Open a long/short trade panel with `<OpenPerpsTrade/>`.
- Price orders from the on-chain mark, not from a client-side chart price.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then start this example
cd examples/dex-terminal
npm install
npm run dev      # or: npm run build
```

## How It Works

| Piece | Role |
|---|---|
| `@openperps/react` | Provides the `<OpenPerpsChart/>` and `<OpenPerpsTrade/>` widgets. |
| `@openperps/sdk` | Provides market config types, House Vault counterparty resolution, and helpers for reading the on-chain mark used as the execution price. |

You can swap in your own chart, add markets to the registry, or wire a different market-data source. The OpenPerps widgets can stay the same.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
