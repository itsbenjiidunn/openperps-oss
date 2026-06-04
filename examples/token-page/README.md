# Token Page Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> One token page mapped to one perp market: chart, long/short, and position, all
> from `@openperps/react`.

This example shows the simplest surface: a single token page bound to a single
market config, with the chart, trade, and position widgets embedded. The whole
integration lives in [`src/App.tsx`](src/App.tsx).

<!-- Add a short demo GIF of the token page here, for example
     ../../.github/assets/token-page-demo.gif -->

## What it demonstrates

- Map a single token page to one `OpenPerpsMarketConfig`.
- Embed a price chart (`<OpenPerpsChart/>`).
- Embed a long/short trade widget (`<OpenPerpsTrade/>`).
- Embed the user's position (`<OpenPerpsPosition/>`).

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

Open the printed URL and connect a wallet. A trade needs an initialized, funded
portfolio; deposit collateral through `@openperps/sdk` first.

## How it works

| Piece | Role |
|-------|------|
| `@openperps/react` | `<OpenPerpsChart/>`, `<OpenPerpsTrade/>`, and `<OpenPerpsPosition/>` |
| `@openperps/sdk` | The market config type and the on-chain mark used as the execution price |

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
