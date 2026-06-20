# Launchpad Example

A token launch page that adds perp trading for the launching token, with `@opp-oss/react` and `@opp-oss/sdk`.

This example shows how a launchpad turns a new token into a tradable perp from its launch page: create the market, then embed the trade, chart, and position widgets. The core integration lives in `src/App.tsx`.

## What It Demonstrates

- Create a custom perp market for a launching token with `<OpenPerpsMarketLauncher/>`.
- Open a long/short trade panel on the launch page with `<OpenPerpsTrade/>`.
- Render a price chart from integrator-provided candles with `<OpenPerpsChart/>`.
- Show the user's open position with `<OpenPerpsPosition/>`.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then start this example
cd examples/launchpad
npm install
npm run dev      # or: npm run build
```

## How It Works

| Piece | Role |
|---|---|
| `@opp-oss/react` | Provides `<OpenPerpsMarketLauncher/>` plus the trade, chart, and position widgets. |
| `@opp-oss/sdk` | Provides the market creation intent and config types behind the launcher. |

The launcher builds a market from an `OpenPerpsMarketCreationIntent`; swap the intent fields, the chart source, or the surrounding page to fit your launch flow. The OpenPerps widgets can stay the same.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@opp-oss/sdk`](../../packages/sdk/README.md)
- [`@opp-oss/react`](../../packages/react/README.md)
