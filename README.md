<div align="center">

# OpenPerps OSS

### The open-source perp layer for Solana apps

**Add long/short markets to any token, from any trading surface.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@openperps/sdk?logo=npm&label=npm)](https://www.npmjs.com/package/@openperps/sdk)
[![Rust](https://img.shields.io/badge/Rust-54.2%25-orange?logo=rust&logoColor=white)](https://github.com/itsbenjiidunn/openperps-oss/search?l=rust)
[![TypeScript](https://img.shields.io/badge/TypeScript-43.5%25-blue?logo=typescript&logoColor=white)](https://github.com/itsbenjiidunn/openperps-oss/search?l=typescript)

</div>

---

**OpenPerps OSS** is the infrastructure Solana apps embed to offer **perpetual futures** on the tokens they already show: launchpads, DEX terminals, swap UIs, Telegram bots, wallets, or analytics dashboards.

**One SDK, one keeper, one risk engine**, reused across all of them. The SDK is the primary integration surface; React components and the keeper are built on top of it, so a web app, a backend script, and a bot all share the same power.

It is built on **[Percolator](https://github.com/aeyakovenko/percolator) v16**, the formally-verified risk engine by Anatoly Yakovenko ([@toly](https://github.com/aeyakovenko)). You get a formally-verified risk core without building or auditing one yourself: Percolator is the pure risk brain and ships no program, decoder, or deployment, and OpenPerps OSS is the body around it: the Solana program, the client SDK, the UI kit, and the keeper.

## Table of Contents

- [Who it is for](#who-it-is-for)
- [What it gives you](#what-it-gives-you)
- [Architecture](#architecture)
- [Quick start](#quick-start)
  - [SDK](#sdk)
  - [React](#react)
  - [Keeper](#keeper)
- [Examples](#examples)
- [Deploy your own](#deploy-your-own)
- [Packages](#packages)
- [Build and test](#build-and-test)
- [How the on-chain program works](#how-the-on-chain-program-works)
- [Repository layout](#repository-layout)
- [License](#license)

---

## Who it is for

Any surface that already shows a Solana token can add perps on it:

| Surface | What you add |
| --- | --- |
| **Launchpads** | A *Create Perp* button and a trade panel on the token page |
| **DEX terminals** | A long/short panel next to the chart |
| **Swap UIs & aggregators** | Perps on the token page |
| **Telegram bots** | `/perp_create`, `/long`, `/short`, `/positions`, `/close` |
| **Wallets & portfolio apps** | Show perp positions, PnL, close and withdraw |
| **Analytics dashboards** | Open interest, volume, liquidations, oracle health |

The "what you add" column is just a common starting point per surface, not a limit. The SDK exposes the same full set (create a market, trade, close, manage) to every one of them, so any app can do as much or as little as it wants.

---

## What it gives you

| Capability | What you build with it |
| --- | --- |
| **Create perp market** | A perp market for a token / mint / pool already in your app |
| **Seed LP & House vault** | Liquidity so users have a counterparty for every trade |
| **Long / short** | Open a position from a page, a bot, or a wallet |
| **Close position** | Close and settle PnL |
| **Mark price & decoders** | Read spot, mark, entry, liquidation, and uPnL from on-chain state |
| **Chart & trade feed** | Plug your own candle and fill data into the chart and feed widgets |
| **Keeper** | Push oracle/funding updates, clear stale slots, scan liquidations |
| **Account decoders** | Read market, portfolio, position, and vault state |

---

## Architecture

Four layers. The **SDK is the core**; React and the bot helpers are adapters over it, so a backend script or a Telegram bot has the same power as a web app.

```
  Trading surfaces                          Keeper
  (launchpad, DEX terminal, swap UI,        (oracle / funding cranks,
   Telegram bot, wallet, dashboard)          liquidations)
       |                                         |
       v                                         |
  Adapters                                       |
  (@openperps/react widgets + hooks,             |
   backend / bot helpers)                        |
       |                                         |
       v                                         |
  @openperps/sdk  (the core client)              |
       |                                         |
       v                                         v
  Solana program  (crates/program, zero-copy)
       |
       v
  Percolator engine  (crates/engine, vendored, risk math)
```

### Layers

| Layer | What | Who uses it |
| --- | --- | --- |
| **Protocol** | Solana program, risk engine, vaults, market accounts, liquidation | Protocol devs, auditors |
| **SDK** | TypeScript for create market, deposit, trade, close, withdraw, decode | Every dapp, bot, backend |
| **UI kit** | React widgets and headless hooks for trade, chart, positions, status | Web apps, terminals |
| **Keeper kit** | Self-hostable keeper for oracle/funding cranks and liquidation | Self-hosting integrators |

---

## Quick start

### SDK

```bash
npm install @openperps/sdk @solana/web3.js @solana/spl-token
```

`@solana/web3.js` and `@solana/spl-token` are peer dependencies, so the SDK shares your app's single instance of each.

```ts
import {
  createJsonMarketRegistry,
  buildTradeFromIntent,
  transactionFromInstructions,
} from "@openperps/sdk";

// 1. Load a market from your registry (a list of OpenPerpsMarketConfig you ship).
const registry = createJsonMarketRegistry(markets);
const market = await registry.getMarket("SOL-PERP");
if (!market) throw new Error("unknown market");

// 2. `counterparty` is this market's House portfolio and `executionPrice` is the
//    current on-chain mark your keeper publishes. The examples below wire both
//    end to end; here they are the only two inputs you provide.
const built = buildTradeFromIntent({
  intent: { schemaVersion: 1, marketId: market.id, side: "long", size: "1000000" },
  market, // OpenPerpsMarketConfig
  counterparty, // { housePortfolio } for this market
  executionPrice, // bigint, the on-chain mark
  owner: wallet.publicKey,
});

const tx = transactionFromInstructions(built.instructions, { feePayer: wallet.publicKey });
// sign + send with your wallet adapter
```

What the SDK gives you:

- **Trade build and resolution.** `resolveTrade` checks an intent against the market and on-chain mark (size, side, reduce-only, slippage); `buildTradeFromIntent` composes the on-chain instructions against the user's portfolio and the House counterparty.
- **Market creation.** `planMarketCreation` and `buildMarketCreationInstructions` compose the full lifecycle (market account, vault, House, oracle binding) for a custom market on any token.
- **Account decoders.** `decodePortfolioSummary`, `decodePortfolioPositions`, and the layout offsets read market, portfolio, and position state.
- **Price providers.** Bring your own `PriceProvider` (Pyth, a pool read, your own oracle) or use `createStaticPriceProvider` for tests.
- **Instruction encoders.** Low-level `accrueAssetIx`, `liquidateIx`, and the rest, mirroring the Rust program, for when you need to compose by hand.

### React

```bash
npm install @openperps/react @openperps/sdk react @solana/web3.js @solana/wallet-adapter-react
```

`react`, `@solana/web3.js`, and `@solana/wallet-adapter-react` are peer dependencies, so the components use your app's existing wallet and connection providers.

```tsx
import {
  OpenPerpsTrade,
  OpenPerpsPosition,
  OpenPerpsChart,
  OpenPerpsMarketLauncher,
} from "@openperps/react";

<OpenPerpsTrade market={market} counterparty={house} executionPrice={mark} />
<OpenPerpsPosition market={market} owner={wallet.publicKey} />
<OpenPerpsChart market={market} candles={candles} />
<OpenPerpsMarketLauncher intent={creationIntent} onLaunch={createMarket} />
```

The components ship no CSS so you need style them through `className` or the default `openperps-*` class names. Prefer to drive the flow yourself? Use the headless hook:

```tsx
import { useOpenPerpsTrade } from "@openperps/react";

const { placeTrade, pending, error } = useOpenPerpsTrade({ market, counterparty });

await placeTrade({ side: "long", size: "1000000", executionPrice: mark });
```

`placeTrade` resolves the intent (counterparty, limit, slippage, reduce-only guards), builds the `PlaceOrder` transaction, signs it with the connected wallet, and confirms it.

### Keeper

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { createStaticPriceProvider } from "@openperps/sdk";
import { runKeeper, type KeeperMarket } from "@openperps/keeper";

const connection = new Connection(process.env.OPENPERPS_RPC!, "confirmed");
const authority = Keypair.fromSecretKey(/* your oracle authority key */);

const markets: KeeperMarket[] = [
  { config: marketConfig, maxAccrualDtSlots: 1000, maxPriceMoveBpsPerSlot: 10 },
];

await runKeeper(
  { connection, authority, priceProvider: createStaticPriceProvider(100_000_000n) },
  markets,
  { intervalMs: 60_000 },
);
```

A keeper is part of the risk system, not just a price cron: it pushes oracle/funding updates on-chain and submits liquidations across many markets. Key points:

- **Authority.** For `AccrueAsset`, the keeper `authority` keypair must match the market's oracle authority, or the program rejects the update. By default that is the program's global relayer constant; a market can rotate it per market with `setOracleAuthorityIx` (an `[ORACLE_SEED, market]` PDA), in which case set `useOracleAuthorityPda: true` on that `KeeperMarket`.
- **Freshness.** The keeper respects the engine's per-slot price-move bound and `max_accrual_dt_slots` window. A large jump is split into steps that each stay within the per-slot move budget (`oldPrice * maxPriceMoveBpsPerSlot * dt / 10000`), so no single `AccrueAsset` is rejected for moving too far too fast. When a market falls behind, it bursts catch-up accruals before risk-increasing trades. See [`docs/keeper-freshness.md`](./docs/keeper-freshness.md).
- **Liquidation.** `discoverLiquidatable` scans the program's portfolios and returns the candidates for a market (open position in the asset, minus the House); `liquidatePortfolio` simulates first so a healthy account costs no fee, and `scanLiquidations` lands only the genuinely liquidatable ones. The keeper finds and clears underwater accounts on its own; front discovery with an indexer for a very large deployment.
- **Monitoring.** Create a `KeeperHealth`, pass it on `deps.health`, and the runner records per-market last crank, slots behind, staleness, last error, and failure streak. `summarizeHealth` returns `{ healthy, staleMarkets, failingMarkets }` for a one-glance `/health` endpoint.

> v1 keeper scope is intentionally small: no analytics, candles, billing, hosted tenant registry, trade-feed API, or SLA system.

---

## Examples

Runnable integrations live in [`examples/`](./examples), each a small app or script wired to the SDK. Each one is a single surface showing a slice; the SDK and widgets are the same everywhere, so any app can integrate the full set (list a market and trade it), as the terminal does:

| Example | What it shows |
| --- | --- |
| [`dex-terminal`](./examples/dex-terminal) | One app that both lists new perps and trades existing markets |
| [`launchpad`](./examples/launchpad) | Create a perp market for a launching token, then trade it |
| [`token-page`](./examples/token-page) | One token page bound to one market (chart, trade, position) |
| [`wallet-position-card`](./examples/wallet-position-card) | The read side: a wallet's positions and PnL, no trade panel |
| [`telegram-bot`](./examples/telegram-bot) | A command bot (`/long`, `/short`, ...) with an explicit signing boundary |
| [`node-create-market`](./examples/node-create-market) | A backend script that builds and registers a market from a creation intent |

Each folder has its own README. See [`docs/examples.md`](./docs/examples.md) for the longer tour.

---

## Deploy your own

OpenPerps OSS is self-hosted: you deploy the program to the cluster you choose and operate it yourself.

1. **Build the program** with the Solana toolchain:

   ```bash
   cargo build-sbf --manifest-path crates/program/Cargo.toml
   # -> target/deploy/openperps_program.so
   ```

2. **Deploy it** and note the program id:

   ```bash
   solana program deploy target/deploy/openperps_program.so
   ```

3. **Create your first market** with the SDK (`planMarketCreation` +
   `buildMarketCreationInstructions`). [`examples/node-create-market`](./examples/node-create-market)
   is a complete script that builds, registers, and prints the derived market,
   vault, and House addresses.

4. **Fund the House vault**, point [`@openperps/keeper`](./packages/keeper) at the
   market, and you are live.

Work through [`docs/deployment-checklist.md`](./docs/deployment-checklist.md) for the operational decisions (oracle source, keeper, liquidity, risk parameters, custody) before a deployment goes in front of users.

---

## Packages

| Package | Version | License | Role |
| --- | --- | --- | --- |
| **[`@openperps/sdk`](./packages/sdk)** | 1.1.0 | Apache-2.0 | The core client. High-level typed functions that hide PDAs, instruction tags, account layouts, and atom/price math |
| **[`@openperps/react`](./packages/react)** | 1.1.0 | MIT | Drop-in widgets (`<OpenPerpsTrade/>`, `<OpenPerpsChart/>`, `<OpenPerpsPosition/>`, `<OpenPerpsMarketLauncher/>`) and headless hooks |
| **[`@openperps/keeper`](./packages/keeper)** | 1.1.0 | Apache-2.0 | Core-only self-host keeper: oracle/funding cranks and liquidation across many markets |

The SDK is the primary integration surface. The React components are the fast path for teams that want ready-made UI; the keeper is the risk-side cron you run yourself.

---

## Build and test

### Protocol: engine + program

The Rust workspace uses a `fat` LTO release profile and a custom `sbf` profile for the on-chain build. The vendored engine keeps its upstream Kani formal-verification config.

```bash
# Unit + integration tests for engine + program
cargo test -p openperps-program
```

### TypeScript packages: one workspace install

`packages/*` is an npm workspace. Each package compiles to `dist/` (`.js` + `.d.ts`) via `tsc`, and `prepublishOnly` rebuilds it, so `npm install @openperps/sdk` gives a consumer runnable JS plus types, not raw TypeScript.

```bash
npm install        # root: links @openperps/sdk, @openperps/react, @openperps/keeper
npm run build      # builds sdk, then react, then keeper
npm test           # builds the sdk, then runs each package's tests
npm run typecheck  # builds the sdk, then type-checks every package
```

> [!NOTE]
> The build order matters: `react` and `keeper` depend on the compiled `@openperps/sdk`, so the root `build` / `test` / `typecheck` scripts always build the SDK first. The apps and examples consume the same packages locally, so **run `npm run build` once at the root** before installing or building them.

---

## How the on-chain program works

The vendored Percolator engine is **zero-copy on-chain**. There is no allocation and no serialization on the hot path: account byte buffers are reinterpreted in place (via `bytemuck`) as fixed-layout POD structs, and engine operations mutate those bytes directly. This is what lets the risk engine fit inside an SBF program at all.

### Account layout

```
Market account data:
  [ OpenPerpsMarketHeader (208 bytes) ][ MarketGroupV16HeaderAccount ][ MarketSlot ; N ]
  (MarketSlot = Market<MarketWrapper>)

Portfolio account data (one per user):
  [ PortfolioAccountV16Account ]   (source domains inline, CAP = 32)
```

Each market and each portfolio is a single account. The program splits off the 208-byte OpenPerps wrapper header (`MARKET_HEADER_VERSION = 4`), which carries the discriminator, version, oracle kind, and OpenPerps-specific config the engine does not model, then builds the matching engine view over the remaining bytes and calls the engine method, which mutates in place. A portfolio holds up to **16 legs** (`V16_MAX_PORTFOLIO_ASSETS_N = 16`).

The engine's production methods carry a `_not_atomic` suffix (for example `deposit_not_atomic`). That is the engine signalling that **the OpenPerps wrapper owns atomicity, persistence, and authorization**. The engine only does the risk math.

### Instruction to engine map

The program dispatches its instructions in `processor.rs`. The ones that drive risk math go through zero-copy `*_buffer` helpers:

| Instruction | Engine entry |
| --- | --- |
| `InitMarket` | zero-copy header / slots init |
| `InitPortfolio` | zero-copy portfolio PDA init |
| `Deposit` | `deposit_not_atomic` |
| `Withdraw` | `withdraw_not_atomic` |
| `ActivateMarket` | `activate_market_buffer` |
| `AccrueAsset` | `accrue_asset_buffer` |
| `Trade` / `PlaceOrder` | `trade_buffer` |
| `PlaceBatchOrder` | `batch_trade_buffer` |
| `Liquidate` | `liquidate_account_not_atomic` |
| `ResolveMarket` | `resolve_market_not_atomic` |
| `SettlePnl` | `settle_pnl_buffer` |
| `CrankPyth` | reads a Pyth `PriceUpdateV2`, then `accrue_asset_buffer` |
| `CrankDexSpot` | reads the DEX pool reserves, then accrues the mark |

The remaining instructions are wrapper-side and do no engine math: SPL vault custody (`CreateVault`, `CreateHouseVault`, `FundHouseVault`, `WithdrawHouseVault`), oracle binding (`SetDexPool`), config (`SetOracleAuthority`, `SetDepositCap`), and delegation (`SetDelegate`).

> Collateral custody is an SPL token vault plus CPI, with a separate **House vault** acting as the counterparty for every `PlaceOrder`.

See [`docs/architecture.md`](./docs/architecture.md) for verified line references into the vendored engine.

---

## Repository layout

The repo layout follows the layers:

```
openperps-oss/
├── crates/
│   ├── engine/        # Percolator risk engine (vendored, upstream 051e268)
│   └── program/       # Solana on-chain program (zero-copy)
├── packages/
│   ├── sdk/           # @openperps/sdk      core TypeScript client
│   ├── react/         # @openperps/react    web widgets + hooks
│   └── keeper/        # @openperps/keeper   self-host keeper template
├── apps/
│   ├── web/           # @openperps/frontend  reference app (consumes the packages)
│   └── indexer/       # fills / PnL / liquidation indexer
├── examples/          # integration examples
├── scripts/           # build helpers (e.g. rewrite-dts-extensions.mjs)
├── docs/              # architecture.md, keeper-freshness.md, deployment-checklist.md
├── Cargo.toml         # Rust workspace (engine + program)
└── package.json       # npm workspace (packages/*)
```

The SDK source mirrors the program, one module per concern: `layout`, `instructions`, `config`, `intents`, `price`, `market-state`, `decoders`, `transactions`, `actions`, `trade-resolution`, `market-creation`, `trade-build`, `market-create-build`.

---

## License

**Apache-2.0**, with per-package exceptions noted in each package (`@openperps/react` is MIT). The vendored engine retains its upstream Apache-2.0 license and the Percolator disclaimer.

See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
