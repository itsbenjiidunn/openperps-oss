# Oracle And Price Safety

OpenPerps OSS is not the market-data provider. Integrators bring their own price
source and chart data.

Client-rendered prices, chart prices, and third-party frontend prices (Birdeye,
DexScreener, GMGN) are for display and prefill only. Settlement, PnL, funding,
and liquidation use the on-chain mark, advanced through the keeper/oracle path.
The SDK's `fetchMarketState` reads the on-chain mark; use its `markPrice` as a
trade's `executionPrice`, never a chart price.

## Price paths and their status

| Path | How it prices | Status |
| --- | --- | --- |
| Authority relayer (`AccrueAsset`) | An off-chain relayer signs and pushes the mark on-chain; the engine enforces a per-slot move bound and a freshness window. | Operator-controlled. The price-setting key defaults to a pinned relayer constant; a market authority rotates it per market with `SetOracleAuthority` (a `[ORACLE_SEED, market]` PDA), without a program upgrade. A verifiable per-asset feed is on the roadmap. |
| DEX-EWMA (`CrankDexSpot`) | A permissionless crank reads a real constant-product pool's two SPL vault reserves, derives the spot, and folds it into the mark via an EWMA (alpha 0.2), bounded by the per-slot move cap and freshness window. | Implemented. `CrankDexSpot` prices from the pinned vaults and rejects a pool below a per-market depth floor (`PoolTooThin`). A program-side TWAP is the next layer. The token-less `CreateMockPool` / `MockSwap` demo source stays behind the `devnet` cargo feature. |
| Pyth (`oracle_kind = PYTH`) | A Pyth feed id is bound to the market. | Implemented. `CrankPyth` reads the Pyth receiver's `PriceUpdateV2` account, checks its owner, feed id, Full verification, freshness, confidence interval, and spot/EMA divergence, then accrues the mark, bounded by the per-slot clamp. Validated against a live Pyth SOL/USD `PriceUpdateV2` account (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`). A decentralized feed (Wormhole guardian quorum), not a single app key. |

## Already enforced

- Per-slot price-move bound (`max_price_move_bps_per_slot`): a single accrual
  cannot move the mark beyond the bound; a large catch-up is split into steps.
- Freshness window (`max_accrual_dt_slots`): a stale slot locks risk-increasing
  trades until it is cranked forward.
- A per-portfolio collateral cap on DEX-priced markets bounds the profit an
  attacker can extract by manipulating a thin pool. `CrankDexSpot` adds a
  per-market quote-depth floor on top.

## Roadmap

- The operator-controlled relayer path (`AccrueAsset`) sets the mark from a pinned
  key, rotatable per market via `SetOracleAuthority`. A verifiable feed for every
  asset is the next layer; the Pyth path already provides one for supported feeds.
- DEX-EWMA gates on pool depth; a program-side TWAP, so a manipulator must sustain
  a move across a window, is the next layer.

Depth- and TWAP-aware DEX-EWMA for custom tokens is detailed in
[`oracle-integration.md`](oracle-integration.md).
