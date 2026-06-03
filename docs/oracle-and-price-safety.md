# Oracle And Price Safety

OpenPerps OSS is not the market-data provider. Integrators bring their own price
source and chart data.

Client-rendered prices, chart prices, and third-party frontend prices (Birdeye,
DexScreener, GMGN) are for display and prefill only. Settlement, PnL, funding,
and liquidation use the on-chain mark, advanced through the keeper/oracle path.
The SDK takes the execution price as an explicit value sourced from on-chain mark
state, never a chart price.

## Price paths and their status

| Path | How it prices | Status |
| --- | --- | --- |
| Authority relayer (`AccrueAsset`) | An off-chain relayer signs and pushes the mark on-chain; the engine enforces a per-slot move bound and a freshness window. | **Live on devnet.** The price-setting key defaults to a single pinned relayer constant; a market authority can rotate it per market with `SetOracleAuthority` (a `[ORACLE_SEED, market]` PDA), without a program upgrade. Still a trusted price-setter, not a trustless feed. |
| DEX-EWMA (`CrankOracle`) | A permissionless crank reads a pinned on-chain pool's spot price and folds it into the mark via an EWMA (alpha 0.2), bounded by the per-slot move cap and freshness window. | **Partial.** EWMA, move bound, and freshness exist. The devnet pool is a token-less mock (`CreateMockPool` / `MockSwap`, gated out of mainnet builds). A real AMM reader plus pool-depth / TWAP checks are not implemented yet. |
| Pyth (`oracle_kind = PYTH`) | A Pyth feed id is bound to the market. | **Stub.** The feed id is stored, but the on-chain Pyth CPI is not implemented; price is still authority-seeded. Do not rely on it for settlement. |

## Already enforced

- Per-slot price-move bound (`max_price_move_bps_per_slot`): a single accrual
  cannot move the mark beyond the bound; a large catch-up is split into steps.
- Freshness window (`max_accrual_dt_slots`): a stale slot locks risk-increasing
  trades until it is cranked forward.
- A per-portfolio collateral cap on DEX-priced markets bounds the profit an
  attacker can extract by manipulating a thin pool. This is a coarse backstop,
  not a substitute for pool-depth checks.

## Known gaps

- The authority relayer is a trusted key. It is now rotatable per market via
  `SetOracleAuthority`, but a trusted key still sets the price; this is not a
  trustless feed.
- DEX-EWMA has no pool-depth or TWAP check yet: a thin or Sybil-funded pool can
  still be pushed within the per-slot bound.
- Pyth settlement is not wired.
