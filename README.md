# OpenPerps

The open-source perp layer for Solana apps. Add long/short markets to any token,
from any trading surface.

OpenPerps is the infrastructure a Solana app embeds to offer perpetual futures
on the tokens it already shows: a launchpad, a DEX terminal, a swap UI, a
Telegram bot, a wallet, or an analytics dashboard. One SDK, one keeper, one risk
engine, reused across all of them.

> Devnet by default. Mainnet-capable, not production-approved.
>
> OpenPerps v1 is unaudited. Do not use with real user funds unless you complete
> your own review and accept the risk.

Mainnet-capable means SDK/config/program flows can target `mainnet-beta`. The
current authority-pushed oracle path is not production-approved and is the main
blocker for serious mainnet use.

It is built on [Percolator](https://github.com/aeyakovenko/percolator) v16, the
formally-verified risk engine by Anatoly Yakovenko (@toly). Percolator is the
pure risk brain and ships no program, decoder, or deployment. OpenPerps is the
body around it: the Solana program, the client SDK, the UI kit, and the keeper.

**OpenPerps OSS and OpenPerps App.** This repo is OpenPerps OSS: the program,
SDK, keeper, React components, examples, and docs. OpenPerps App, the live
trading application, is the first application built on OpenPerps OSS.

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
| `@openperps/react` | Web widgets (`<OpenPerpsTrade/>`, `<OpenPerpsChart/>`, `<OpenPerpsPositions/>`) and headless hooks |
| `@openperps/bot` | Adapter and example helpers for Telegram trading bots |
| `@openperps/keeper` | Self-host keeper template (Cloudflare Worker / D1 / Durable Objects) |

The repo layout follows the layers: `crates/engine`, `crates/program`,
`packages/sdk`, `packages/react`, `packages/bot`, `packages/keeper`, `apps/web`
(reference app), `examples/`, and `docs/`.

## Build and test

```bash
# Protocol: engine + program, unit + integration tests
cargo test -p openperps-program
```

The TypeScript packages each build with `npm ci && npm run build` (or
`typecheck`). See each package's README.

## Status

Live on devnet, not independently audited. The Percolator engine in
`crates/engine` is Kani-formally-verified upstream and vendored unmodified. The
OpenPerps program, SDK, and keeper are not. The oracle trust model on devnet
lets the signing authority set the price; production replaces that with a real
oracle. Treat mainnet use as your own risk decision.

## License

Apache-2.0, with per-package exceptions noted in each package. The vendored
engine retains its upstream Apache-2.0 license and the Percolator disclaimer.
See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
