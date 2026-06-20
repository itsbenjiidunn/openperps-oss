# @opp-oss/sdk

[![npm](https://img.shields.io/npm/v/@opp-oss/sdk?logo=npm&label=npm)](https://www.npmjs.com/package/@opp-oss/sdk)
[![license](https://img.shields.io/npm/l/@opp-oss/sdk)](./LICENSE)

**The open-source perp layer for Solana apps.** Add long/short markets to any
token, from any trading surface.

`@opp-oss/sdk` is the core client of [OpenPerps OSS](https://github.com/itsbenjiidunn/openperps-oss):
the infrastructure Solana apps embed to offer **perpetual futures** on the tokens
they already show, launchpads, DEX terminals, swap UIs, Telegram bots, wallets, or
analytics dashboards. The SDK is the primary integration surface; the React
widgets and the keeper are built on top of it, so a web app, a backend script, and
a bot all share the same power.

It is built on **[Percolator](https://github.com/aeyakovenko/percolator) v16**, the
formally-verified risk engine by Anatoly Yakovenko ([@toly](https://github.com/aeyakovenko)).
You get a formally-verified risk core without building or auditing one yourself:
Percolator is the pure risk brain, and OpenPerps OSS is the body around it (the
Solana program, this SDK, the UI kit, and the keeper). The SDK hides PDAs,
instruction tags, account layouts, and atom/price math behind small typed
functions.

## Install

```bash
npm install @opp-oss/sdk @solana/web3.js @solana/spl-token
```

`@solana/web3.js` and `@solana/spl-token` are peer dependencies, so the SDK shares
your app's single instance of each.

## What it gives you

| Capability | What you build with it |
| --- | --- |
| **One-call listing** | `createPerpMarket(mint)`: read the token's signals, pick its risk tier, and emit the whole market lifecycle in one call |
| **Create perp market** | A perp market for a token / mint / pool already in your app |
| **Seed LP and House vault** | Liquidity so users have a counterparty for every trade |
| **Live price feed** | `createLivePriceProvider`: price any token off DexScreener then Jupiter, for markets with no Pyth feed |
| **Long / short** | Open a position from a page, a bot, or a wallet |
| **Close position** | Close and settle PnL |
| **Mark price and decoders** | Read spot, mark, entry, liquidation, and uPnL from on-chain state |
| **Instruction encoders** | Low-level `accrueAssetIx`, `liquidateIx`, and the rest, mirroring the Rust program |

## Quick start

### List a perp on any token (one call)

`createPerpMarket` reads the token's live signals, classifies its risk tier and
oracle posture, scales the live price, and returns every instruction to stand up a
usable market plus a portable config. It is build-only: you supply the market rent
(one RPC call) and a fresh market keypair, then sign and send.

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createPerpMarket, marketAccountSize } from "@opp-oss/sdk";

const conn = new Connection(rpcUrl, "confirmed");
const marketKp = Keypair.generate();
const rent = await conn.getMinimumBalanceForRentExemption(marketAccountSize(1));

const listing = await createPerpMarket({
  baseMint, // the token mint to list
  quoteMint, // your collateral mint (e.g. mUSDC)
  programId,
  authority: payer.publicKey,
  market: marketKp.publicKey,
  marketRentLamports: rent,
  houseCapBase: 500_000n, // bound the House exposure
  minFeeBps: 10n, // enforce a trading-fee floor
});

// listing.instructions -> sign with [payer, marketKp] and send.
// listing.config -> a portable OpenPerpsMarketConfig for your registry / keeper.
```

A memecoin (thin, new, volatile) resolves to a Volatile tier on a MANUAL relayer
oracle; a deep, mature token resolves to Stable on DEX-EWMA or Pyth. The classifier
is conservative by construction.

### Open a trade

```ts
import {
  createJsonMarketRegistry,
  buildTradeFromIntent,
  transactionFromInstructions,
} from "@opp-oss/sdk";

const registry = createJsonMarketRegistry(markets); // your OpenPerpsMarketConfig list
const market = await registry.getMarket("SOL-PERP");
if (!market) throw new Error("unknown market");

const built = buildTradeFromIntent({
  intent: { schemaVersion: 1, marketId: market.id, side: "long", size: "1000000" },
  market, // OpenPerpsMarketConfig
  counterparty, // { housePortfolio } for this market
  executionPrice, // bigint, the on-chain mark your keeper publishes
  owner: wallet.publicKey,
});

const tx = transactionFromInstructions(built.instructions, { feePayer: wallet.publicKey });
// sign + send with your wallet adapter
```

## Capabilities in detail

- **Trade build and resolution.** `resolveTrade` checks an intent against the
  market and on-chain mark (size, side, reduce-only, slippage); `buildTradeFromIntent`
  composes the on-chain instructions against the user's portfolio and the House
  counterparty.
- **Market creation.** `createPerpMarket(mint)` is the one-call listing;
  `planMarketCreation` and `buildMarketCreationInstructions` compose the same
  lifecycle (market account, vault, House, oracle binding) by hand for full
  control. The off-chain `classifyMarketTier` suggests the risk tier and oracle
  posture from a token's signals.
- **Price providers.** `createLivePriceProvider` prices any token off DexScreener
  then Jupiter, scaling it to the market's mark decimals and holding the last good
  price when both are momentarily down, for relayer markets with no Pyth feed. Or
  bring your own `PriceProvider` (Pyth, a pool read, your own oracle);
  `createStaticPriceProvider` is for tests and demos.
- **Account decoders.** `decodePortfolioSummary`, `decodePortfolioPositions`, and
  the layout offsets read market, portfolio, position, and vault state.
- **Instruction encoders.** Low-level `accrueAssetIx`, `liquidateIx`,
  `placeOrderIx`, `setMarketFeeIx`, and the rest mirror the Rust program for when
  you compose by hand.

## Oracle modes

A market chooses one `oracle_kind`:

- **Pyth**, for majors with a feed. A permissionless `CrankPyth` reads a verified
  `PriceUpdateV2`, bound to the market's feed id, checking Full verification,
  freshness, a confidence bound, and EMA divergence.
- **DEX-EWMA**, for a token with a real pool but no Pyth feed. `CrankDexSpot`
  reads constant-product reserves on-chain into a capped, time-weighted EWMA
  behind a depth floor, so a single-block reserve flash contributes near zero.
- **MANUAL / relayer**, for memecoins and long-tail tokens. A keeper pushes the
  mark via `AccrueAsset`, signed by a per-market oracle authority (a production
  build has no single shared key); the price is sourced live from DexScreener then
  Jupiter via `createLivePriceProvider`.

All modes bound manipulation with a per-slot price-move clamp plus EWMA smoothing,
and a `require_verifiable` flag keeps Pyth / DEX-EWMA markets verifiable-only.

## The kit

- [`@opp-oss/react`](https://www.npmjs.com/package/@opp-oss/react): drop-in widgets
  (`<OpenPerpsTrade/>`, `<OpenPerpsChart/>`, `<OpenPerpsPosition/>`,
  `<OpenPerpsMarketLauncher/>`) and headless hooks over this SDK.
- [`@opp-oss/keeper`](https://www.npmjs.com/package/@opp-oss/keeper): the self-host
  keeper and the `openperps-relayer` daemon (oracle/funding cranks, a live mark for
  relayer markets, liquidation scanning).
- [Examples and full docs](https://github.com/itsbenjiidunn/openperps-oss): a
  token page, DEX terminal, launchpad, wallet card, Telegram bot, and a node
  market-creation script.

## License

Apache-2.0. Built on [Percolator](https://github.com/aeyakovenko/percolator) v16
by Anatoly Yakovenko ([@toly](https://github.com/aeyakovenko)).
