# Wallet Position Card Example

A wallet or portfolio card that shows a connected wallet's perp positions and PnL, with `@opp-oss/react` and `@opp-oss/sdk`.

This example shows the read side: a wallet or portfolio app surfaces a user's open positions across a curated set of markets, with no trade panel. The core integration lives in `src/App.tsx`.

## What It Demonstrates

- List a wallet's positions across markets with `<OpenPerpsPosition/>`.
- Show unrealized PnL.
- Show a liquidation price estimate when available.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then start this example
cd examples/wallet-position-card
npm install
npm run dev      # or: npm run build
```

## How It Works

| Piece | Role |
|---|---|
| `@opp-oss/react` | Provides the `<OpenPerpsPosition/>` widget, one per market. |
| `@opp-oss/sdk` | Provides the market config type for the markets to display. |

A wallet only needs the read and manage side (positions, PnL, close, withdraw), so this example leaves out the order-entry surface entirely.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@opp-oss/sdk`](../../packages/sdk/README.md)
- [`@opp-oss/react`](../../packages/react/README.md)
