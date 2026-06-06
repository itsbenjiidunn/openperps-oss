# DEX Terminal Example

A trading terminal that both lists new perp markets and trades existing ones, with `@openperps/react` and `@openperps/sdk`.

This example shows one app doing both halves of the kit: a `List a perp` flow that creates a market for any token, and a chart plus long/short panel to trade markets that exist. The split across the examples is only for illustration; the SDK and widgets are the same everywhere, so any surface can integrate the full capability. The core integration lives in `src/App.tsx`.

## What It Demonstrates

- List a new perp for any token with `<OpenPerpsMarketLauncher/>`.
- Load and filter the market list, select a market.
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
| `@openperps/react` | Provides `<OpenPerpsMarketLauncher/>` (list a perp), and the `<OpenPerpsChart/>` and `<OpenPerpsTrade/>` widgets (trade it). |
| `@openperps/sdk` | Provides market config and creation-intent types, House Vault counterparty resolution, and helpers for reading the on-chain mark used as the execution price. |

You can swap in your own chart, add markets to the registry, or wire a different market-data source. The OpenPerps widgets can stay the same.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
