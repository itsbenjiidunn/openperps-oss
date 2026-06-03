# OpenPerps Whitepaper

## Abstract

OpenPerps is a Solana perpetual futures protocol built around the Percolator v16
risk engine. The project separates a lean, formally reasoned core from a
user-facing trading layer that supports collateral custody, market creation,
single-click long/short trading, liquidation, oracle updates, and indexed
activity feeds.

The protocol has two operating surfaces. Mainnet is designed for curated,
high-liquidity markets such as SOL-PERP, BTC-PERP, and ETH-PERP with real USDC
collateral and production oracle feeds. Devnet exposes the experimental
permissionless launcher, where anyone can create a demo perpetual market for an
existing SPL asset, bind it to an oracle model, seed an LP and Insurance Vault,
and trade with mock USDC.

OpenPerps is not an order book and not a traditional AMM. The underlying engine
performs matched long/short accounting between portfolio accounts. OpenPerps
wraps this primitive with an LP and Insurance Vault that acts as the default
counterparty, allowing a normal trader to open or close a position with one
wallet and one trading account.

## 1. Motivation

Perpetual futures are one of the highest-volume use cases in crypto, but most
perp venues rely on centralized matching, off-chain risk engines, permissioned
market listings, or complex liquidity systems that are difficult to audit.
Solana provides enough throughput for an on-chain derivatives venue, but the
hard parts remain:

- pricing volatile assets safely,
- tracking margin and PnL across positions,
- custodying collateral without centralized control,
- liquidating unhealthy accounts deterministically,
- letting users create or trade markets without understanding protocol internals.

Percolator v16 provides a compact risk-engine foundation for this problem. It is
zero-copy, allocation-free on the production path, and built around account-local
portfolio state. OpenPerps adds the missing Solana protocol layer: program
wrappers, SPL token custody, market metadata, vault accounts, frontend flows,
and indexer infrastructure.

## 2. Design Goals

OpenPerps is built around five goals.

First, the core must remain lean. Risk logic should be small enough to reason
about, cheap enough to execute, and stable enough for independent review.

Second, the protocol should use account-local portfolio state rather than a
single global slab. A user portfolio is its own account, which improves
composability and avoids forcing all users through one shared write-locked
structure.

Third, the user interface should hide raw engine instructions. A trader should
see markets, collateral, long/short buttons, PnL, and withdrawals. They should
not need to understand `InitPortfolio`, matched-cross internals, PDAs, or crank
instructions before placing a trade.

Fourth, market launch should mean launching a perpetual market for an existing
asset, not minting a new token. A market is defined by an underlying asset, a
quote collateral mint, an oracle binding, risk parameters, and liquidity.

Fifth, mainnet and devnet should serve different purposes. Mainnet starts with
curated, safer markets. Devnet remains the experimental surface for
permissionless SPL market creation and oracle research.

## 3. System Overview

OpenPerps consists of five layers:

- the Percolator v16 risk engine,
- the Solana program wrapper,
- SPL collateral vaults and LP and Insurance Vaults,
- a TypeScript SDK and frontend,
- an indexer for market discovery, trades, PnL, and activity feeds.

The engine stores market and portfolio state in fixed-size account buffers. The
program wrapper validates ownership, signer permissions, account sizes, vault
addresses, token transfers, and instruction payloads. The frontend and SDK turn
these low-level operations into product flows such as launching a market,
depositing USDC, opening a long, closing a position, and withdrawing collateral.

On devnet, the full experimental flow is available:

1. choose an existing asset or custom SPL mint,
2. bind the market to an oracle model,
3. create the market and token vault,
4. create and fund the LP and Insurance Vault,
5. activate the market,
6. let traders deposit mock USDC and trade.

On mainnet, the intended initial surface is narrower:

1. curated markets are deployed by the protocol,
2. collateral is real USDC,
3. major assets use production oracle feeds,
4. custom SPL market launch remains disabled,
5. traders use the terminal to deposit, long, short, close, and withdraw.

## 4. Risk Engine

The protocol uses Percolator v16 as its risk engine. Percolator is not a full
DEX by itself. It is a risk-accounting library that defines market groups,
portfolio accounts, margin checks, funding accrual, trade application,
withdrawal constraints, liquidation, and recovery paths.

The production path is zero-copy. Market accounts and portfolio accounts are
fixed byte buffers interpreted as typed views. The engine does not allocate
vectors on-chain and does not serialize high-level objects at runtime. This is
important for Solana because compute units and account borrow rules make
allocation-heavy designs expensive and harder to reason about.

OpenPerps keeps the engine isolated. The wrapper owns the Solana-specific work:

- instruction decoding,
- signer checks,
- account ownership checks,
- SPL Token CPI,
- PDA derivation,
- rent-funded account creation,
- oracle authentication,
- frontend-compatible account decoding.

This boundary lets the risk engine remain small while still giving users a
complete product surface.

## 5. Market Model

An OpenPerps market is a perpetual market for an existing asset. It is not a new
token.

A market contains:

- a symbol, such as `SOL-PERP` or `BTC-PERP`,
- an underlying asset identifier,
- an optional SPL base mint,
- a quote collateral mint,
- a collateral vault,
- an oracle binding,
- risk metadata such as max leverage and fee bps,
- an LP and Insurance Vault that can take the other side of trades.

For synthetic assets such as BTC and ETH, the base mint can be empty because the
market references an external price feed rather than an SPL token. For Solana
native tokens or custom SPL assets, the base mint identifies the underlying
asset being tracked.

The market account is self-describing. The wrapper header records the quote
mint, vault PDA, authority, underlying base mint, oracle kind, oracle feed id,
and oracle pool. This allows wallets, explorers, indexers, and frontends to read
what a market represents directly from chain state.

## 6. Collateral and Portfolio Accounts

OpenPerps is quote-margined. A trader deposits quote collateral, initially USDC
on mainnet and mock USDC on devnet, then uses that collateral to trade multiple
perpetual markets.

Each trader opens a portfolio account for a market. The portfolio account holds
capital, PnL, and position legs. This account-local structure is different from
global slab designs: each user state is a separate account, so composing with
other programs, wallets, and account-based workflows is more natural.

Deposits and withdrawals are real SPL token movements. A deposit transfers
tokens from the user's token account into the market vault, then credits the
engine portfolio. A withdrawal debits the engine portfolio and transfers tokens
from the vault back to the user. The engine prevents withdrawal while the
portfolio has unsafe or open state that would make the withdrawal invalid.

## 7. LP and Insurance Vault

The Percolator engine trade primitive is a matched cross between a long
portfolio and a short portfolio. That is a useful low-level primitive, but it is
not a good retail user experience if exposed directly.

OpenPerps introduces an LP and Insurance Vault for each market. The vault is a
PDA-owned portfolio funded by the market authority or liquidity providers. When
a user clicks Long or Short, the `PlaceOrder` flow routes the LP and Insurance
Vault as the opposite side of the cross.

From the user's perspective, they sign one transaction. From the engine's
perspective, every position is still a matched long/short update. This preserves
the accounting model while allowing a normal trading interface.

The vault has three roles:

- provide immediate counterparty liquidity,
- absorb the opposite side of user positions,
- act as the first insurance buffer for market-level risk.

Future versions can expand this model into permissionless LP shares, dynamic
fees, utilization-based pricing, or separated insurance accounting. The current
model keeps the core simpler: one market, one collateral vault, one LP and
Insurance Vault, one deterministic counterparty path.

## 8. Trading Flow

A normal user flow is:

1. connect a wallet,
2. choose a market,
3. create a trading account if needed,
4. deposit USDC,
5. choose Long or Short,
6. set margin and leverage,
7. submit the order,
8. monitor PnL,
9. close the position,
10. withdraw available collateral.

The frontend computes user-facing values such as notional, fee, estimated
liquidation price, and order size. The on-chain program receives the exact
engine parameters and applies the trade through the `PlaceOrder` instruction.

The terminal is market-first. As the number of markets grows, users discover
markets through search, filters, sorting, and badges:

- majors versus custom tokens,
- oracle type,
- leverage tier,
- new markets,
- trending markets,
- volume,
- liquidity,
- open interest.

Clicking a market opens the chart, order panel, account panel, positions, recent
trades, and vault information for that market.

## 9. Oracle Model

OpenPerps supports multiple oracle paths because not all assets have the same
data quality.

For curated mainnet markets such as SOL, BTC, and ETH, the intended oracle path
is a production price feed such as Pyth. These markets are liquid, widely
tracked, and suitable for higher confidence pricing.

For custom SPL assets, especially thinly traded or newly listed markets, OpenPerps
uses a DEX-EWMA model. A market can pin a DEX pool as its price source. A crank reads
the pool spot price and folds it into an exponentially weighted moving average.
This produces a smoother mark price while still deriving from on-chain liquidity
rather than a trusted manual price.

On devnet, OpenPerps can simulate this with a mock constant-product pool. The
pool is not intended as a production oracle. It exists so traders and builders
can test market launch, price movement, PnL changes, and liquidation behavior
without real funds.

For a live-data devnet demo, external price data can also be mirrored into
devnet markets. BTC, SOL, and ETH can track live Pyth or Hermes prices, while a
custom SPL market can mirror a mainnet pool or API price into a devnet oracle
flow. This creates realistic PnL behavior while keeping settlement on devnet.

## 10. Liquidation and Cranking

OpenPerps includes permissionless maintenance paths. Crank operations refresh
market or portfolio state, update oracle/funding inputs, and keep health checks
current. Liquidation can be called permissionlessly against an unhealthy
portfolio. The engine rejects liquidation attempts on healthy accounts.

This design separates normal trader UX from maintenance UX. Traders should not
need to know what a crank is. Keepers, advanced users, and bots can access
maintenance actions through an advanced interface or directly through the SDK.

## 11. Indexer and Data Layer

The Solana program stores canonical state, but a usable trading terminal also
needs derived data:

- market discovery,
- recent trades,
- volume,
- open interest,
- equity curves,
- realized PnL,
- liquidation history,
- funding events,
- trending and new market ranking.

OpenPerps uses an indexer layer to collect and serve this data. The frontend can
merge global indexed data with local wallet activity so a user's own fills
appear immediately while the global feed catches up.

The indexer is not consensus-critical. If it fails, on-chain settlement remains
the source of truth. The user experience degrades from live feeds and ranking
back to direct account reads.

## 12. Mainnet and Devnet Split

OpenPerps deliberately separates mainnet and devnet behavior.

Mainnet should begin with a small curated set of markets:

- SOL-PERP,
- BTC-PERP,
- ETH-PERP.

These markets use real USDC collateral, production oracle feeds, and protocol
managed liquidity. Permissionless custom SPL launch is disabled in the initial
mainnet surface.

Devnet remains the open experimentation layer. Builders can create custom SPL
perp markets, use mock collateral, test DEX-EWMA pricing, move simulated pool
prices, and validate trading flows without real funds.

This split lets OpenPerps prove the product experience and core accounting in a
controlled mainnet scope while preserving the permissionless vision in a safer
environment.

## 13. Security Model

The security model has several layers.

The engine is isolated from Solana-specific concerns and uses zero-copy account
views. The wrapper validates account ownership, signer permissions, vault
addresses, and token program calls. SPL collateral custody is handled through
program-derived token accounts. User funds move only through explicit deposit
and withdrawal instructions.

Market authority is responsible for initialization, activation, and certain
market-level operations. Permissionless operations such as trading, deposits,
withdrawals, cranking, and liquidation are constrained by account ownership and
engine checks.

Oracle security is asset-dependent. Pyth-style feeds are appropriate for major
assets. DEX-derived prices require liquidity, manipulation resistance, caps, and
conservative leverage. Custom SPL markets should begin on devnet until their
oracle and liquidity assumptions are well understood.

The protocol should be considered experimental until audited and battle-tested.

## 14. Roadmap

The near-term roadmap is:

- stabilize the terminal around market discovery and chart-first trading,
- complete live chart data for BTC, SOL, ETH, and selected SPL markets,
- finalize close-position and withdrawal UX,
- improve indexed feeds for trades, PnL, volume, and open interest,
- separate devnet and mainnet configuration cleanly,
- prepare curated mainnet markets for SOL, BTC, and ETH,
- keep permissionless SPL market launch on devnet,
- replace mock oracle paths with production oracle integrations where needed.

Medium-term work includes:

- production pool decoders for DEX-EWMA,
- stronger liquidation stress testing,
- permissionless LP participation,
- better market ranking,
- portfolio-level risk dashboards,
- mobile trading improvements,
- external audits and formal review.

## 15. Risks and Limitations

OpenPerps inherits the risks of perpetual futures systems:

- oracle manipulation,
- insufficient LP liquidity,
- liquidation delay,
- volatile collateral requirements,
- frontend/indexer inconsistency,
- market parameter misconfiguration,
- smart contract bugs.

Custom SPL markets are especially risky because many tokens have thin
liquidity, unstable pools, and poor oracle coverage. For that reason, custom SPL
market launch belongs on devnet until the oracle and risk controls are mature.

Mainnet should launch with a limited market set and conservative parameters.
Expansion should be driven by observed liquidity, oracle quality, and risk
testing rather than by listing speed alone.

## Conclusion

OpenPerps turns Percolator v16 from a research-grade risk engine into a complete
Solana perpetuals protocol surface. Its core thesis is simple: keep the engine
lean, keep accounts composable, make markets self-describing, custody collateral
with SPL vaults, and hide engine internals behind trader-friendly workflows.

The long-term vision is permissionless perpetual market creation for any asset
with sufficient price discovery. The practical path starts narrower: curated
mainnet markets for major assets, plus an open devnet environment where custom
SPL markets, DEX-EWMA oracles, and new liquidity models can be tested safely.

