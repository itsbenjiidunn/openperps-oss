# Token Page Example

A single token page that adds perp trading for one market, with `@opp-oss/react` and `@opp-oss/sdk`.

This example shows the simplest surface: a single token page bound to one market config, with the chart, trade, and position widgets embedded. The core integration lives in `src/App.tsx`.

## What It Demonstrates

- Map a single token page to one `OpenPerpsMarketConfig`.
- Embed a price chart with `<OpenPerpsChart/>`.
- Embed a long/short trade panel with `<OpenPerpsTrade/>`.
- Embed the user's open position with `<OpenPerpsPosition/>`.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then start this example
cd examples/token-page
npm install
npm run dev      # or: npm run build
```

Open the printed URL and connect a wallet. A trade needs an initialized, funded portfolio; deposit collateral through `@opp-oss/sdk` first.

## How It Works

| Piece | Role |
|---|---|
| `@opp-oss/react` | Provides `<OpenPerpsChart/>`, `<OpenPerpsTrade/>`, and `<OpenPerpsPosition/>`. |
| `@opp-oss/sdk` | Provides the market config type and the on-chain mark used as the execution price. |

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@opp-oss/sdk`](../../packages/sdk/README.md)
- [`@opp-oss/react`](../../packages/react/README.md)
