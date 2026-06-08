# Insurance Fund (design)

Status: Phase 1a (the safe vault foundation) is implemented; the deficit-cover
top-up and ADL remain design. This spec describes how a per-market insurance fund
absorbs liquidation shortfalls before the House, and where it sits relative to the
vendored engine.

## What is implemented (Phase 1a)

The fund's capital plumbing, with zero engine-solvency interaction (no deficit
cover yet, so the engine's `vault`/`c_tot`/bankruptcy math is untouched):

- **Per-market insurance vault** at `[INSURANCE_SEED, market]`, an SPL token
  account for the market's quote mint (`CreateInsuranceVault`, authority-only).
- **Permissionless funding** (`FundInsuranceVault`): anyone may transfer quote
  tokens into the backstop, which can only ever raise the balance.
- **Config PDA** at `[INSURANCE_CFG_SEED, market]` (`SetInsuranceParams`,
  authority-only) holding the withdrawal floor (`min_balance`) and the optional
  withdrawal timelock (`withdraw_delay_slots`). Both are **raise-only** (a
  ratchet), so the fund's guarantees can only strengthen; loosening is deferred to
  a later governance phase.
- **Two-step, floor-bounded withdrawal**: `RequestInsuranceWithdraw` records a
  pending (amount, unlock = now + delay) only if the amount leaves the floor
  intact; `ExecuteInsuranceWithdraw` pays out once the timelock elapses,
  re-checking the floor against the live balance and clearing the pending slot.

This makes the fund trustworthy to fund and bound before any deficit-cover logic
exists: the floor and the announced-ahead timelock mean a capitalized fund cannot
be silently drained, and the authority can be a single key or a multisig/timelock
program at the operator's choice (the protocol enforces the floor and ratchet, the
operator chooses how strong the authority is).

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

## Decisions made

- **Cross-market vs per-market funds: per-market (resolved).** Each market has its
  own `[INSURANCE_SEED, market]` vault, mirroring the isolated-House model. Because
  market creation is permissionless, a shared pool would be an adversarial-drain
  target (spin up a market on a pool you control, manufacture a deficit, drain the
  pool honest markets funded); per-market funds are self-limiting and the
  accounting is trivial (balance = the vault's token balance). A shared pool can be
  an opt-in layer later.
- **Governance of withdrawals: floor + raise-only ratchet + optional timelock
  (resolved).** The protocol enforces a withdrawal floor and announces any drain
  the configured timelock ahead; both knobs are raise-only. Multisig is not
  forced; the operator points the authority at whatever key they want (single key,
  multisig, or timelock program). Loosening the floor or shortening the delay is
  left to a later governance phase.

## Open questions (still for review)

- ADL trigger and selection: which profitable accounts, and how much, when fund
  and House are both empty. **Gated on engine research:** the vendored engine owns
  the bankruptcy-domain settlement, so the first step is reading whether it already
  socializes internally before designing any wrapper-level ADL (the wrapper must
  compose with, not duplicate, the engine's own accounting). This blocks the
  deficit-cover top-up (Phase 1b) too.

## Phasing

- **Phase 1a (implemented).** Insurance vault + config (floor + raise-only
  timelock) + permissionless funding + the two-step, floor-bounded withdrawal. No
  engine interaction, so it is safe to ship ahead of the solvency-critical pieces.
- **Phase 1b (gated).** Fee/penalty cut routing into the vault, and the
  deficit-cover top-up (keeper- or authority-triggered) that restores `vault >=
  c_tot` after a shortfall. Gated on the engine-research question above (the
  top-up must compose with, not duplicate, the engine's bankruptcy accounting),
  so it is deliberately not part of Phase 1a.
- **Phase 2.** In-handler automatic deficit cover inside `Liquidate` /
  `ResolveMarket`, so no external trigger is needed.
- **Phase 3.** ADL as the bounded last resort when fund and House are depleted.
