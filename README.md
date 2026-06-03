# OpenPerps OSS

[![npm](https://img.shields.io/npm/v/@openperps/sdk?logo=npm&label=npm)](https://www.npmjs.com/package/@openperps/sdk)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/itsbenjiidunn/openperps-oss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/itsbenjiidunn/openperps-oss/actions/workflows/ci.yml)

The open-source perp layer for Solana apps. Add long/short markets to any token,
from any trading surface.

OpenPerps OSS is the infrastructure a Solana app embeds to offer perpetual
futures on the tokens it already shows: a launchpad, a DEX terminal, a swap UI, a
Telegram bot, a wallet, or an analytics dashboard. One shared risk core, one SDK,
one keeper path, reused across all of them.

It is built on [Percolator](https://github.com/aeyakovenko/percolator) v16, the
formally-verified risk engine by Anatoly Yakovenko (@toly). Percolator provides the verified risk-engine foundation. OpenPerps OSS keeps that risk core upstream and packages the surrounding Solana integration layer: program wrapper, SDK, React kit, keeper, account decoders, examples, and deployment docs.

**This repo.** OpenPerps OSS is that open layer: the program, SDK, keeper, React
components, examples, and docs, open and self-hostable, so integrators run their
own stack rather than routing through a middleman.

## Quickstart

```bash
npm install @openperps/sdk @solana/web3.js @solana/spl-token
```

```ts
import { buildTradeFromIntent, transactionFromInstructions } from "@openperps/sdk";

// Build a long from a validated intent against the market's House/LP counterparty.
const built = buildTradeFromIntent({
  intent: { schemaVersion: 1, marketId: market.id, side: "long", size: "1000000" },
  market,            // OpenPerpsMarketConfig
  counterparty,      // resolved House / LP portfolio
  executionPrice,    // bigint, from the keeper / on-chain mark
  owner: wallet.publicKey,
});

const tx = transactionFromInstructions(built.instructions, {
  feePayer: wallet.publicKey,
});
// sign + send with your wallet adapter
```

`@openperps/react` wraps this in a drop-in `<OpenPerpsTrade/>` widget, and
`@openperps/keeper` runs the oracle crank and liquidations. See each package's
README.

## Who it is for

Any surface that already shows a Solana token can add perps on it:

- **Launchpads**: a Create Perp button and a trade panel on the token page.
- **DEX terminals**: a long/short panel next to the chart (GMGN, Photon style).
- **Swap UIs and aggregators**: perps on the token page (Jupiter, Raydium style).
- **Telegram bots**: `/perp_create`, `/long`, `/short`, `/positions`, `/close`.
- **Wallets and portfolio apps**: show perp positions, PnL, close and withdraw.
- **Analytics dashboards**: open interest, volume, liquidations, oracle health.

## What it gives you

| Capability | What you build with it |
|------------|------------------------|
| Create perp market | A perp market for a token/mint/pool already in your app |
| Seed LP and insurance vault | Liquidity so users have a counterparty |
| Long / short | Open a position from a page, a bot, or a wallet |
| Close position | Close and settle PnL |
| Chart and mark price | Candles, spot, mark, entry, liquidation, uPnL |
| Trade feed | Global or per-user fills |
| Keeper | Crank the oracle, clear stale slots, scan liquidations |
| Account decoders | Read market, portfolio, position, and vault state |

## Architecture

Four layers. The SDK is the core; React and the bot helpers are adapters over
it, so a backend script or a Telegram bot has the same power as a web app.

| Layer | What | Who uses it |
|-------|------|-------------|
| Protocol | Solana program, risk engine, vaults, market accounts, liquidation | Protocol devs, auditors |
| SDK | TypeScript for create market, deposit, trade, close, withdraw, decode | Every dapp, bot, backend |
| UI kit | React widgets and headless hooks for trade, chart, positions, status | Web apps, terminals |
| Keeper kit | Self-hostable keeper for oracle crank, liquidation, candles, indexing | Self-hosting integrators |

## Packages

| Package | Role |
|---------|------|
| `@openperps/sdk` | The core client. High-level functions that hide PDAs, instruction tags, account layouts, and atom math |
| `@openperps/react` | Web widgets (`<OpenPerpsTrade/>`, `<OpenPerpsChart/>`, `<OpenPerpsPosition/>`, `<OpenPerpsMarketLauncher/>`) and headless hooks |
| `@openperps/keeper` | Self-host keeper for the oracle crank, funding accrual, and liquidations |

A Telegram trading bot ships as a runnable example (`examples/telegram-bot`)
built on `@openperps/sdk` rather than as a separate package.

The repo layout follows the layers: `crates/engine`, `crates/program`,
`packages/sdk`, `packages/react`, `packages/keeper`, `apps/web` (example app),
`apps/indexer`, `examples/`, and `docs/`.

## Build and test

```bash
# Protocol: engine + program, unit + integration tests
cargo test -p openperps-program

# TypeScript packages: one workspace install, then build / test / typecheck
npm install            # root: links @openperps/sdk, @openperps/react, @openperps/keeper
npm run build          # compiles each package to dist/ (.js + .d.ts)
npm test               # runs every package's test suite
npm run typecheck      # type-checks every package
```

`packages/*` is an npm workspace. Each package publishes its compiled `dist`
(`main`, `types`, and `exports` point there, and `prepublishOnly` rebuilds it),
so `npm install @openperps/sdk` gives a consumer runnable JS plus types, not raw
TypeScript. The apps and examples consume the same packages locally; run
`npm run build` once at the root before installing or building them. See each
package's README.

## Scope

OpenPerps OSS is infrastructure. The
[Percolator](https://github.com/aeyakovenko/percolator) risk engine in
`crates/engine` is Kani-formally-verified upstream and vendored unmodified;
OpenPerps OSS adds no risk logic of its own. Integrators own their deployment:
the oracle path, liquidity and risk parameters, keeper operator, and market
registry are yours to configure and review. See [`SECURITY.md`](SECURITY.md) for
the trust boundary, and [`docs/`](docs/) for the permission map, oracle model,
and deployment checklist.

## License

Apache-2.0, with per-package exceptions noted in each package. The vendored
engine retains its upstream Apache-2.0 license and the Percolator disclaimer.
See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
