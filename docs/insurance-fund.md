# Insurance Fund (design)

Status: design for review. Not implemented. This spec describes how a per-market
insurance fund would absorb liquidation shortfalls before the House, and where it
sits relative to the vendored engine.

## The gap it closes

A liquidation recovers what the account can pay. If price gaps faster than the
keeper can liquidate, an account can cross zero equity: the close leaves a
**shortfall** (the engine's recorded `c_tot` for that account exceeds what the
vault actually backs). Today that shortfall lands on the **House** (the
counterparty to every trade); if the House cannot cover it, the deficit is stuck
or socialized. The engine's bankruptcy domains account for this correctly, but
there is **no capital backstop** sized to absorb it. The insurance fund is that
backstop.

## Loss-absorption waterfall

When a liquidation (or resolution) leaves a market deficit (`vault < c_tot`):

1. **The liquidated account first.** Close its positions and apply the
   liquidation penalty; this recovers as much as the account holds.
2. **Insurance fund.** The remaining shortfall is covered by transferring from
   the insurance vault into the market vault, up to the fund balance and a
   per-event cap.
3. **House.** If the fund is depleted, the House absorbs the rest (current
   behavior).
4. **Socialized loss / ADL (last resort).** If fund and House are both depleted,
   the deficit is shared across profitable accounts (auto-deleverage). This is
   the explicit, bounded failure mode rather than a stuck market.

The fund sits between the account and the House, so it protects the House (and
therefore every other trader the House backs) up to its balance.

## Funding sources

The fund is capitalized from protocol revenue, never from a free withdrawal:

- **Trading-fee cut.** A configurable fraction of each trade fee (`fee_bps`)
  routes to the fund instead of the House.
- **Liquidation penalty cut.** A fraction of the `liquidation_fee` collected on
  each liquidation.
- **Optional funding cut.** A slice of funding payments.
- **Seed deposit.** The market authority can fund it at launch and top it up.

All cuts are per-market parameters; a market with a deep, mature House can run a
small cut, a thin/experimental market a larger one.

## On-chain shape

The engine in `crates/engine` is vendored and owns the solvency math (`vault`,
`c_tot`, bankruptcy domains); it is not modified. The fund is therefore a
**wrapper-level** mechanism around the engine, mirroring how the House vault is
already a wrapper construct:

- **Insurance vault.** An SPL token account at a PDA `[INSURANCE_SEED, market]`,
  holding the fund's quote tokens (same mint as the market vault).
- **Accounting.** The fund balance is the vault's token balance; a small header
  field tracks the configured cut bps and the per-event payout cap.
- **Instructions (new, wrapper-side):**
  - `CreateInsuranceVault` / `FundInsuranceVault` / `WithdrawInsuranceVault`
    (authority-gated; withdrawal only down to a floor, or only by governance).
  - `SetInsuranceParams` (fee/penalty cut bps, per-event cap), authority-gated,
    a `[INSURANCE_SEED, market]` PDA in the SetHouseCap / SetDexPool style.
  - Deficit cover is applied inside the existing `Liquidate` / `ResolveMarket`
    handlers: after the engine call, if the engine reports a market deficit, the
    wrapper transfers from the insurance vault into the market vault to restore
    `vault >= c_tot`, bounded by the fund balance and the per-event cap, and
    credits the engine vault through the same path a deposit uses.

The fee/penalty cut is applied where the wrapper already computes the fee, by
splitting it between the House and the insurance vault.

## The hard part

Restoring solvency from the wrapper must not violate engine invariants. The safe
path is to treat an insurance top-up exactly like an external deposit into the
market vault (the engine already accepts deposits that raise `vault`), so the
engine sees a consistent `vault`/`c_tot` after the transfer. The deficit-detection
read and the top-up must happen atomically inside the same instruction as the
liquidation, so no state is observable with `vault < c_tot` and an uncovered
deficit.

## Parameters

- `insurance_fee_cut_bps`, `insurance_penalty_cut_bps`: revenue routed to the fund.
- `max_event_payout`: cap on a single deficit cover (limits a bad oracle event to
  draining the fund slowly, not at once).
- `min_balance`: withdrawal floor.

## Open questions (for review)

- ADL trigger and selection: which profitable accounts, and how much, when fund
  and House are both empty.
- Cross-market vs per-market funds: per-market is simpler and isolates risk
  (consistent with the isolated-House model); a shared fund pools capital but
  couples markets.
- Governance of withdrawals (multisig / timelock) so the fund cannot be drained.
- Interaction with the engine's existing bankruptcy-domain settlement: the
  wrapper top-up must compose with, not duplicate, the engine's own accounting.

## Phasing

- **Phase 1.** Insurance vault + params + fee/penalty cut routing + keeper- or
  authority-triggered top-up on a detected deficit. The keeper already scans for
  liquidations; it can also detect and top up a deficit.
- **Phase 2.** In-handler automatic deficit cover inside `Liquidate` /
  `ResolveMarket`, so no external trigger is needed.
- **Phase 3.** ADL as the bounded last resort when fund and House are depleted.
