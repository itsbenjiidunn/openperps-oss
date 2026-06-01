# OpenPerps OSS SDK-first Design Spec

## Status

Draft for review.

Implementation workspace: `D:\Working\openperps-oss`. The existing `C:\Users\Admin\openperps` repo is the source project until the OSS workspace is created/copied.

## Positioning

OpenPerps is an open-source perp layer for Solana apps.

It lets Solana applications add permissionless perpetual markets, trading, positions, PnL, and keeper automation through SDKs and embeddable components.

The SDK is the primary integration surface. React components provide a fast integration path for teams that want ready-made trade, chart, and position UI. Teams can also use the SDK directly to build their own interface, bot, or backend flow.

## Target Integrators

OpenPerps v1 should support multiple Solana trading surfaces through one shared SDK core:

- launchpads
- token pages
- DEX terminals
- swap UIs
- wallets and portfolio apps
- Telegram trading bots
- backend scripts
- market maker tools
- keeper operators

The project should not pick one surface as the only intended user. The SDK defines the common protocol interface. Each surface gets a thin adapter, widget, or example.

## Goals

1. Make `@openperps/sdk` the clean public API for OpenPerps.
2. Support both official markets and custom SPL markets.
3. Provide both low-level builders and high-level actions.
4. Provide both build-only transactions and send-ready actions.
5. Define reusable market config, trade intent, and market creation intent formats.
6. Let integrators bring their own price source and chart data.
7. Provide a core-only self-host keeper for oracle crank, funding crank, and liquidation.
8. Provide embeddable React components for teams that want fast UI integration.
9. Provide examples for launchpads, DEX terminals, wallets, bots, and backend scripts.
10. Keep OSS v1 mainnet-capable at the SDK/config level, devnet-default in examples, permissive-license, and explicit about unaudited risk.
11. Keep the vendored risk engine aligned with Toly's percolator v16.8.5 baseline and make any wrapper-specific adaptation explicit.

## Non-goals

OpenPerps OSS v1 should not prioritize:

- points systems
- leaderboard
- retail growth loops
- hosted billing
- analytics dashboard
- full candle backend
- activity feed
- token economics
- staking
- revenue share
- production mainnet claims

Hosted/KaaS can be mentioned as a future direction, but it should not shape v1 docs or APIs.

The `$OPP` token should not be mentioned in OSS v1 material.

## Market Types

### Official Markets

Official markets are curated markets such as SOL, BTC, ETH, or JUP.

They can have curated market config, liquidity, keeper setup, and safer defaults.

SDK APIs should make official markets easy to discover and trade:

```ts
getOfficialMarkets()
getOfficialMarket(symbol)
buildTradeFromIntent(intent)
placeTrade(intent, signer)
```

### Custom SPL Markets

Custom SPL markets let integrators create perp markets for their own token or another SPL token.

For v1, integrators are responsible for:

- selecting the token and quote mint
- supplying the price source
- supplying chart data if they render a chart
- seeding LP and insurance liquidity
- running the keeper or choosing a keeper operator
- understanding manipulation and liquidation risk

Custom market APIs should use a market creation intent:

```ts
type OpenPerpsMarketCreationIntent = {
  schemaVersion: 1;
  baseMint: string;
  quoteMint: string;
  symbol: string;
  name?: string;
  initialPrice: string;
  maxLeverage: number;
  riskTier: "major" | "standard" | "experimental";
  priceProvider: {
    type: "external";
    id: string;
    description?: string;
  };
  lpVault?: {
    initialDeposit?: string;
  };
};
```

### Market Creation To On-chain Mapping

`OpenPerpsMarketCreationIntent` is an SDK format. Creating a usable custom market is a composed lifecycle, not a single engine call.

For v1, `createMarket(intent)` should compose or guide this sequence:

1. `InitMarket`
   - creates the market account with wrapper metadata
   - binds base mint, quote mint, asset slot, market authority, and oracle metadata
2. `CreateVault`
   - creates the SPL custody vault for user collateral
3. `CreateHouseVault`
   - creates the House/LP/insurance portfolio or vault used as market counterparty
4. `FundHouseVault`
   - moves `lpVault.initialDeposit` into the House/LP vault when provided
5. `ActivateMarket`
   - turns the asset slot live with an initial mark price
6. Optional devnet/demo setup
   - `CreateMockPool` or demo price adapter setup when the integrator is not using a real external source
7. Oracle binding
   - records enough metadata for the keeper to map `priceProvider.id` to the market's oracle path

`priceProvider.id` is not a trusted price by itself. It is an integration identifier used by the keeper configuration. The keeper signer and configured oracle authority must still satisfy program authority checks.

Required market creation lifecycle test before claiming this complete:

- create custom market from `OpenPerpsMarketCreationIntent`
- create vault and House/LP counterparty
- fund House/LP through `lpVault.initialDeposit`
- activate the market
- run one keeper/oracle update
- open a trade against the House/LP counterparty
- assert market, vault, House/LP, and portfolio state are usable

## Market Config

Market config should be rich enough for launchpads, bots, DEX terminals, and wallets.

It must include `schemaVersion` from v1 so external registries and cached configs can evolve safely.

```ts
type OpenPerpsMarketConfig = {
  schemaVersion: 1;
  id: string;
  cluster: "devnet" | "mainnet-beta";
  programId: string;
  market: string;
  assetIndex: number;

  baseMint: string;
  quoteMint: string;
  symbol: string;
  name?: string;

  priceDecimals: number;
  sizeDecimals: number;
  quoteDecimals: number;

  poolAddress?: string;
  dex?: string;
  createdBy?: string;
  riskTier: "major" | "standard" | "experimental";
  maxLeverage: number;
  status: "draft" | "active" | "paused" | "close-only" | "settled";

  keeper?: {
    oracleAuthority?: string;
    expectedCrankIntervalMs?: number;
  };

  metadata?: {
    logoURI?: string;
    website?: string;
    tags?: string[];
  };
};
```

`status` is an off-chain integration hint for registries, UIs, bots, and keepers. It is not an on-chain guarantee. In v1, on-chain state is still enforced by the program's actual market mode and instruction guards. If an integrator marks a market `paused` or `close-only`, their own frontend, bot, keeper, or relayer must enforce that policy.

`maxLeverage` is also config/risk metadata. The engine enforces margin and risk constraints, but it does not have a native "max leverage" field matching this config. SDK helpers may use `maxLeverage` for preflight checks and UI constraints.

`priceDecimals`, `sizeDecimals`, and `quoteDecimals` are display and conversion metadata. The engine uses fixed internal scales, including 1e6-style fixed point quantities. SDK helpers are responsible for converting integrator/user-facing units into engine atoms.

## Market Discovery

V1 should use a registry interface, not a mandatory on-chain registry.

Reason:

- launchpads already have token databases
- DEX terminals already have market lists
- bots can load config from JSON or API
- wallets can curate supported markets
- an on-chain registry can be added later without blocking v1 adoption

SDK interface:

```ts
type MarketRegistryProvider = {
  listMarkets(): Promise<OpenPerpsMarketConfig[]>;
  getMarket(id: string): Promise<OpenPerpsMarketConfig | null>;
};
```

OpenPerps should provide:

- in-memory registry
- JSON registry
- HTTP registry example

## SDK Surface

The SDK should have two layers.

### Low-level Layer

Low-level APIs expose instruction builders, PDA helpers, and decoders.

Examples:

```ts
buildInitMarketIx(...)
buildInitPortfolioIx(...)
buildDepositIx(...)
buildWithdrawIx(...)
buildPlaceTradeIx(...)
buildAccrueAssetIx(...)
buildLiquidateIx(...)
deriveMarketPda(...)
derivePortfolioPda(...)
decodeMarket(...)
decodePortfolio(...)
decodePosition(...)
```

This layer is for advanced integrators, custom transaction composition, and audits.

### High-level Layer

High-level APIs expose common user flows.

Examples:

```ts
buildCreateMarketTx(intent)
createMarket(intent, signer)

buildInitPortfolioTx(market, owner)
initPortfolio(market, signer)

buildDepositTx(params)
deposit(params, signer)

buildTradeFromIntent(intent)
placeTrade(intent, signer)

buildWithdrawTx(params)
withdraw(params, signer)

fetchPosition(owner, market)
fetchMarketState(market)
```

Every high-level send-ready action should have a build-only equivalent.

## Engine Baseline

OpenPerps should stay close to the upstream percolator v16.8.5 risk engine baseline.

Requirements:

- re-vendor the engine from the pinned upstream SHA before recording the baseline as current
- record the upstream source and pinned SHA in `NOTICE` or engine docs
- keep `crates/engine` as a vendored engine baseline, not an untracked rewrite
- document wrapper-specific adaptations, including `SettlePnl`
- adapt `SettlePnl` to the v16.8.5 released-PnL flow instead of the older House-debit settle path
- verify layout stability with the existing `print_byte_sizes_for_sdk` test
- verify program behavior with `cargo test -p openperps-program`
- when updating engine code, include a diff/review note explaining what changed from upstream

The goal is not to claim OpenPerps is upstream Percolator. The goal is to make the fork boundary auditable.

## Trade Intent

Trade intent is the shared format between UI, bots, DEX terminals, and backend systems.

```ts
type OpenPerpsTradeIntent = {
  schemaVersion: 1;
  marketId: string;
  side: "long" | "short";
  size: string;
  limitPrice?: string;
  maxSlippageBps?: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
};
```

`size` means desired position size in base units after applying `sizeDecimals`. It is not margin. Margin/collateral comes from capital already deposited in the user's portfolio. SDK preflight should check that available portfolio capital can satisfy initial margin/risk requirements for the requested size.

`clientOrderId` is client-side correlation metadata only in v1. It is useful for bots, logs, and UI reconciliation, but it is not enforced as a unique on-chain order id.

Required SDK helpers:

```ts
validateTradeIntent(intent)
quoteTradeIntent(intent, marketState)
buildTradeFromIntent(intent)
placeTrade(intent, signer)
```

This lets a Telegram bot, DEX terminal, and React trade panel share the same order format.

Minimum quote state shape:

```ts
type QuoteMarketState = {
  markPrice: string;
  feeBps?: number;
  openInterestLong?: string;
  openInterestShort?: string;
  fundingRateE9?: string;
  slotLast?: number;
  currentSlot?: number;
};
```

`quoteTradeIntent` should use `markPrice` as the execution reference, apply fee estimates when available, and surface staleness when `slotLast` is too far behind `currentSlot`.

### Intent To On-chain Mapping

`OpenPerpsTradeIntent` is an SDK format, not an on-chain order type.

For v1, `placeTrade` should resolve the intent as follows:

1. Load `OpenPerpsMarketConfig` from the configured `MarketRegistryProvider`.
2. Fetch current market/portfolio state through RPC.
3. Resolve the counterparty:
   - official markets use the configured shared House/LP portfolio
   - custom SPL markets use the creator/integrator House or LP portfolio from config
   - if no counterparty is configured, SDK must fail before building the transaction
4. Resolve execution price from keeper-certified/on-chain mark state, not from client chart data.
5. Convert human size into engine `sizeQ`/notional atoms using market decimals.
6. Build the appropriate matched-cross `PlaceOrder`/trade instruction against the resolved counterparty.
7. Run SDK preflight guards before sending.

Client chart price, DOM price, and third-party frontend price can prefill UI fields, but they must not be the settlement price for `placeTrade`.

`limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK-side guards in v1:

- `limitPrice` checks that the resolved execution price is acceptable before building/sending
- `maxSlippageBps` checks difference between requested reference price and resolved execution price
- `reduceOnly` checks decoded position state and refuses to increase exposure

These are not native on-chain order semantics in v1. Apps must not present them as an orderbook-style on-chain guarantee.

`maxLeverage` is enforced by SDK/UI preflight and by integrator risk policy. The engine enforces its own margin/risk constraints, but it does not directly enforce the config field named `maxLeverage`.

### Action Result Types

High-level SDK actions should return useful result objects for bots and backend systems.

Minimum result shapes:

```ts
type PlaceTradeResult = {
  signature: string;
  marketId: string;
  side: "long" | "short";
  size: string;
  executedPrice: string;
  position?: unknown;
};

type CreateMarketResult = {
  signature: string;
  marketConfig: OpenPerpsMarketConfig;
};
```

Exact `position` typing can become stricter once decoders stabilize.

## Close, Settle, Withdraw Lifecycle

OpenPerps SDK should treat profitable close and withdrawal as a lifecycle, not as independent buttons.

Expected user path:

1. open position against House/LP counterparty
2. mark price changes through keeper/oracle path
3. close position
4. settle realized PnL into withdrawable capital
5. withdraw available capital

The engine requires released/realized PnL to be converted into capital before it is withdrawable. High-level SDK helpers such as `closePosition` and `withdraw` should either guide or compose this flow explicitly.

Required lifecycle test before claiming this complete:

- open position versus House
- move price into profit through the oracle/keeper path
- close position
- settle PnL
- withdraw
- assert portfolio/vault balances changed as expected

## Signing Model

V1 should support three signing models:

### Wallet

Used by browser dapps and embedded widgets.

User signs sensitive actions:

- deposit
- withdraw
- set delegate
- settle user-owned state

### Signer

Used by Node scripts, bots, and backend tools.

Appropriate for:

- devnet examples
- market creation scripts
- keeper authorities
- relayers

### Delegate / Session Key

Used to reduce repeated wallet popups for trading.

Rules:

- wallet owner must explicitly authorize delegate/session key
- delegate can place trades only within the allowed scope
- delegate cannot withdraw funds
- docs must explain the trust boundary clearly

## Permission Map

Integrator docs should include a permission map for all public instructions.

| Instruction | Permission model |
| --- | --- |
| `InitMarket` | Open or configured by market creation flow, depending on deployment policy |
| `InitPortfolio` | Open |
| `Deposit` | Portfolio owner signer |
| `Withdraw` | Portfolio owner signer |
| `Trade` / `PlaceOrder` | Required portfolio owner/delegate signers |
| `Liquidate` | Permissionless; program rejects healthy accounts |
| `CrankRefresh` | Permissionless refresh/protective path |
| `ActivateMarket` | Authority-pinned |
| `AccrueAsset` | Authority-pinned oracle/funding update |
| `ResolveMarket` | Authority-pinned |
| `CreateVault` | Market authority / creation flow |
| `CreateHouseVault` | Market authority / creation flow |
| `FundHouseVault` | Authority-only or configured House/LP funder |
| `WithdrawHouseVault` | Authority-only |
| `SetDelegate` | Portfolio owner signer |
| `SettlePnl` | Portfolio owner/delegate path, according to program guard |

`keeper.oracleAuthority` in market config must match the signer allowed by the program for `AccrueAsset`. If the keeper signs with the wrong key, the program should reject the oracle/funding update.

## Price And Chart Data

OpenPerps does not need to be the market data provider in v1.

Integrators provide their own price source and chart data.

The keeper consumes a price provider interface:

```ts
type PriceProvider = {
  getPrice(market: OpenPerpsMarketConfig): Promise<{
    price: bigint;
    confidence?: bigint;
    slot?: number;
    source: string;
    timestampMs: number;
  }>;
};
```

React chart components should accept external candle data:

```ts
type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
```

Important rule:

Client-rendered prices, chart prices, DOM-scraped prices, and third-party frontend prices can be used for display and prefill only. Settlement, PnL, funding, and liquidation must use the keeper/oracle path.

## React Components

React components provide a fast integration path for teams that want ready-made UI.

Initial components:

```tsx
<OpenPerpsTrade market={market} />
<OpenPerpsChart market={market} candles={candles} />
<OpenPerpsPosition owner={wallet} market={market} />
<OpenPerpsMarketLauncher intent={marketCreationIntent} />
```

The components should be built on the same SDK APIs available to external developers.

They should accept:

- market config
- registry provider
- wallet adapter
- RPC endpoint
- optional theme
- optional chart data
- optional callbacks

The components should not require the host app to use the OpenPerps reference app layout.

## Keeper

`@openperps/keeper` v1 should be core-only.

Responsibilities:

- load multiple market configs
- call price providers
- push oracle/funding updates
- scan for liquidations
- submit liquidation transactions
- log health and errors

Keeper authority rule:

- each market config may define `keeper.oracleAuthority`
- the keeper signer for `AccrueAsset` must match the authority pinned on-chain for that market
- if the signer does not match, oracle/funding cranks should fail and the keeper must surface the error clearly

Keeper freshness and price-move rule:

- the keeper must push oracle updates frequently enough to respect the engine's per-slot price-move bound
- for assets with OI, each `AccrueAsset` update can only move price within the configured `max_price_move_bps_per_slot * dt` budget
- a large price jump or long gap can be rejected by the engine, including `RecoveryRequired`
- `slot_last` must stay within the engine's `max_accrual_dt_slots` freshness window
- if a slot with OI falls stale, risk-increasing trades may be blocked with `LockActive`
- when a market falls behind, the keeper or trade path must burst catch-up accruals before risk-increasing trades can succeed

Non-responsibilities in v1:

- analytics dashboard
- candles
- billing
- hosted tenant registry
- full trade feed API
- SLA system

Runner model:

- multi-market simple runner
- sequential loop is acceptable for v1
- OI-gated optimization can come later

## Examples

V1 should include examples for the main integration surfaces.

### Launchpad Example

Shows:

- create custom market for a token
- embed trade widget
- embed chart shell with launchpad-provided candles
- show position

### DEX Terminal Example

Shows:

- load market registry
- filter markets
- click market
- show chart
- open trade panel

### Token Page Example

Shows:

- one token page
- one market config
- trade and position widgets

### Wallet / Portfolio Example

Shows:

- list user positions
- show PnL
- show liquidation price if available

### Telegram Bot Example

Shows:

- `/market`
- `/long`
- `/short`
- `/position`
- trade intent formatting
- user signing boundary

### Node Create Market Example

Shows:

- create market from intent
- register config in local JSON registry
- run keeper against that config

## Documentation

Required docs:

- `README.md`
- `docs/quickstart.md`
- `docs/engine-upstream.md`
- `docs/sdk.md`
- `docs/market-config.md`
- `docs/trade-intent.md`
- `docs/market-creation-intent.md`
- `docs/lifecycle.md`
- `docs/keeper.md`
- `docs/keeper-freshness.md`
- `docs/react-components.md`
- `docs/examples.md`
- `docs/permissions.md`
- `docs/oracle-and-price-safety.md`
- `docs/security-and-limitations.md`

README should lead with:

> OpenPerps is an open-source perp layer for Solana apps.

README should quickly show three paths:

1. SDK only
2. React components
3. keeper runner

## License

Use a permissive license across v1 packages.

Recommended:

- Apache-2.0 for program, SDK, keeper, examples, docs
- MIT is acceptable for React components if preferred

Keep license simple for v1 adoption.

## Network Support

OpenPerps OSS v1 is not devnet-only.

The SDK, market config, keeper config, and React components should support both:

- `devnet`
- `mainnet-beta`

Examples and quickstarts should use devnet by default because v1 is unaudited. Mainnet-beta support exists at the SDK/config level, but unaudited deployments should not be presented as production-approved or safe for real user funds.

Recommended public wording:

> Devnet by default. Mainnet-capable, not production-approved.

The current manual authority oracle trust model is the main blocker for serious mainnet use. Mainnet-capable in this spec means SDK/config/program flows can target `mainnet-beta`; it does not mean the current oracle path is production-approved.

## Audit Meaning

In this spec, "unaudited" means OpenPerps has not yet received an independent third-party security and risk review.

For OpenPerps, an audit should cover:

- Solana account validation
- signer and authority checks
- PDA derivation and ownership assumptions
- SPL token custody and CPI flows
- deposit and withdraw safety
- delegate/session key permissions
- trade, PnL, funding, and settlement logic
- liquidation correctness
- oracle authority, stale price, and manipulation assumptions
- keeper reliability assumptions
- LP and insurance vault risk
- custom SPL market risk

Until that work is complete, docs should say:

> Mainnet-capable, but unaudited. Use devnet by default. Do not use with real user funds unless you complete your own review and accept the risk.

## Warnings

OSS v1 docs must be explicit:

- devnet by default
- mainnet-capable, not production-approved
- unaudited
- no real user funds unless the integrator completes their own review and accepts the risk
- custom SPL markets are experimental
- integrators are responsible for price source quality
- integrators are responsible for LP and insurance liquidity
- keeper reliability matters for liquidation safety
- client-side prices must not secure settlement
- the current authority-pushed oracle path is not acceptable for production mainnet without a stronger oracle integration and risk review

## Future Direction

Hosted keeper/API can be mentioned as a possible future direction.

Do not include billing, token utility, staking, or buyback mechanics in OSS v1 docs.

## Acceptance Criteria

This spec is successful when:

1. A developer can understand the OpenPerps OSS direction without reading the current frontend.
2. SDK APIs are the first-class integration surface.
3. React components are clearly a fast integration path, not the only path.
4. Custom market data responsibility is clearly assigned to integrators.
5. Keeper v1 scope is limited to core safety operations.
6. Examples cover launchpad, DEX terminal, token page, wallet, bot, and backend script.
7. The docs do not mention `$OPP`.
8. The docs warn strongly against unaudited mainnet use.
9. The docs explain trade intent mapping, SDK-side guards, and the close-settle-withdraw lifecycle.
10. The plan preserves the upstream v16.8.5 engine boundary and records the pinned source.
