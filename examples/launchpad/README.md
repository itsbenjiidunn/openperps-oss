# Launchpad Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> A token launch page that spins up a perp market for the launching token and
> offers trading on it, with `@openperps/react`.

This example shows how a launchpad turns a new token into a tradable perp from its
launch page: create the market, then embed the trade, chart, and position widgets.
The whole integration lives in [`src/App.tsx`](src/App.tsx).

<!-- Add a short demo GIF of the launch + trade flow here, for example
     ../../.github/assets/launchpad-demo.gif -->

## What it demonstrates

- Create a custom perp market for a launching token (`<OpenPerpsMarketLauncher/>`).
- Embed a long/short trade widget on the token launch page.
- Embed a chart with integrator-provided candles.
- Show the user's position.

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

## How it works

| Piece | Role |
|-------|------|
| `@openperps/react` | `<OpenPerpsMarketLauncher/>` plus the trade, chart, and position widgets |
| `@openperps/sdk` | The market creation intent and config types behind the launcher |

The launcher builds a market from an `OpenPerpsMarketCreationIntent`; swap the
intent fields, the chart source, or the surrounding page to fit your launch flow.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
- [`@openperps/react`](../../packages/react/README.md)
