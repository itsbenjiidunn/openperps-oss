# DEX Terminal Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> A minimal trading terminal that embeds perpetual futures with `@openperps/react`
> and `@openperps/sdk`.

This example shows how a DEX terminal adds a long/short panel next to a chart,
using the OpenPerps React widgets. The whole integration lives in
[`src/App.tsx`](src/App.tsx).

<!-- Add a short demo GIF of the running terminal here, for example
     ../../.github/assets/dex-terminal-demo.gif -->

## What it demonstrates

- Load a market registry and filter the market list.
- Select a market to open its detail view.
- Render a price chart (`<OpenPerpsChart/>`) from candle data.
- Open a long/short trade panel (`<OpenPerpsTrade/>`) priced from the on-chain
  mark, never a client/chart price.

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

## How it works

| Piece | Role |
|-------|------|
| `@openperps/react` | Drop-in `<OpenPerpsChart/>` and `<OpenPerpsTrade/>` widgets |
| `@openperps/sdk` | Market config type, House resolution, and reading the on-chain mark used as the execution price |

Swap the chart for your own (TradingView, Lightweight Charts), add markets to the
registry, or wire a different data source. The widgets stay the same.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
