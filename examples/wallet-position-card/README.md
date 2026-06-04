# Wallet Position Card Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> A wallet or portfolio card that lists a connected wallet's OpenPerps positions
> and PnL, with `@openperps/react`.

This example shows the read side: a wallet or portfolio app surfaces a user's
OpenPerps positions across a curated set of markets, with no trade panel. The whole
integration lives in [`src/App.tsx`](src/App.tsx).

<!-- Add a short demo GIF or screenshot of the position card here, for example
     ../../.github/assets/wallet-position-card-demo.gif -->

## What it demonstrates

- List a wallet's OpenPerps positions across markets (`<OpenPerpsPosition/>`).
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

## How it works

| Piece | Role |
|-------|------|
| `@openperps/react` | The `<OpenPerpsPosition/>` widget, one per market |
| `@openperps/sdk` | The market config type for the markets to display |

A wallet only needs the read and manage side (positions, PnL, close, withdraw), so
this example skips the order-entry surface entirely.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
