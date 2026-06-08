# Insurance Fund (design)

Status: Phase 1a (engine-integrated funding + withdrawal governance) is
implemented. The loss-absorption waterfall itself, including insurance consumption
and auto-deleverage, is owned by the vendored, Kani-verified engine and already
runs on every liquidation. This spec describes the engine's model and the thin
wrapper that funds and governs it.

## Where the solvency math lives

The engine in `crates/engine` is vendored byte-for-byte and owns the entire
solvency model (`vault`, `c_tot`, `insurance`, the per-(asset, side) source/credit
domains, and the bankruptcy/socialization machinery). It maintains, at all times
(spec section 5):

```
C_tot <= V
I <= V
V >= C_tot + I
insurance_ledger.total_available <= I
```

So there is **no "stuck deficit" state**: the vault is never allowed to fall below
`c_tot`. A wrapper-level "deficit cover" that tops up `vault` when `vault < c_tot`
would be solving a condition the engine prevents by construction, and injecting
capital outside the engine's `TokenValueFlowProof` would itself break an invariant.
The insurance feature is therefore **not** a parallel backstop; it is funding and
governance for the engine's own insurance ledger.

## The engine's loss-absorption waterfall (already implemented)

`Liquidate` calls the engine's `liquidate_account_not_atomic`, which runs the full
waterfall automatically, all Kani-verified and all preserving `V >= C_tot + I`:

1. **Account principal.** The liquidated account's own capital absorbs the loss
   first, plus the liquidation penalty.
2. **Domain insurance.** `consume_domain_insurance_for_negative_pnl` covers the
   residual negative PnL from the relevant (asset, side) domain's insurance budget,
   up to what that domain holds.
3. **Social residual / ADL.** `apply_bankruptcy_residual_chunk_to_loss_side` charges
   what remains to the loss-side domain via the `social_loss_*` weights (auto-
   deleverage), in bounded chunks. Per spec section 0.5, residual is charged only to
   the asset-side domain whose exposure generated it, never a global pool.
4. **Recovery mode.** If the residual still cannot progress,
   `preflight_liquidation_residual_durability` routes the market to
   `declare_permissionless_recovery(ActiveBankruptCloseCannotProgress)`, the
   bounded, explicit failure mode instead of a stuck market.

This is the account -> insurance -> socialization -> recovery waterfall, owned by
the engine. The wrapper does not re-implement any of it.

## What the wrapper adds (Phase 1a)

The only thing missing was that the engine's insurance ledger starts empty
(`I = 0`), so step 2 above currently covers nothing and losses fall straight to
socialization. Phase 1a lets an operator (or anyone) fund it, and governs its
withdrawal, all through the engine's verified API:

- **`FundInsurance { asset_index, side, amount }`** (permissionless). Transfers
  `amount` quote tokens into the market vault, then calls the engine's
  `deposit_domain_insurance_not_atomic(domain, amount)`, which raises the engine
  vault, total insurance `I`, and the (asset, side) domain budget atomically and
  re-checks every invariant. `domain = asset_index * 2 + side` (0 = Long, 1 =
  Short), matching the engine's `insurance_domain_index`. Funding only ever raises
  `I`, so it is safe to leave permissionless.
- **`SetInsuranceParams { min_balance, withdraw_delay_slots }`** (authority).
  Creates the `[INSURANCE_CFG_SEED, market]` config PDA on first use. `min_balance`
  is a floor on the engine's total insurance `I` that a withdrawal can never breach;
  `withdraw_delay_slots` is the announce-ahead timelock. Both are **raise-only** (a
  ratchet), so the fund's guarantees can only strengthen.
- **`RequestInsuranceWithdraw { asset_index, side, amount }`** then
  **`ExecuteInsuranceWithdraw`** (authority). The two-step, floor-bounded timelock:
  request records a pending (amount, unlock = now + delay, domain) only if the
  amount leaves the floor on `I` intact; execute, once the timelock elapses,
  re-checks the floor against the live `I`, calls the engine's
  `withdraw_domain_insurance_not_atomic` (which refuses to pull below the domain's
  available insurance or the vault), transfers the tokens out signed by the market
  vault PDA, and clears the pending slot.

The config PDA holds **only** governance state (floor, timelock, pending slot). The
insurance capital itself lives in the engine's domain ledger inside the market
vault, so there is no separate token vault to keep in sync.

## Decisions, resolved by reading the engine

- **Per-market vs shared, and the granularity (resolved).** The engine's insurance
  is per-(asset, side) **domain**, strictly isolated, which is a stronger form of
  the per-market choice: residual is charged only to the domain that generated it,
  never socialized across markets. This subsumes the earlier per-market-vs-shared
  question.
- **Governance of withdrawals (resolved).** Floor on `I` + raise-only ratchet +
  optional announce-ahead timelock, enforced by the wrapper around the engine's
  withdraw. Multisig is not forced; the operator points the authority at whatever
  key they want (single key, multisig, or timelock program).
- **ADL / deficit-cover (resolved: owned by the engine).** The engine already
  socializes (auto-deleverages) and consumes insurance internally, maintaining
  `V >= C_tot + I`. A wrapper-level ADL or deficit-cover would duplicate verified
  engine logic (and risk breaking its invariants), so it is **not** built. This was
  the gated open question; the engine research closed it.

## Possible later work (not built)

- **Revenue routing.** Route a configurable cut of the trade fee / liquidation
  penalty into domain insurance via the engine's `account_capital_to_insurance`,
  so the backstop grows from protocol revenue rather than only seed funding.
- **Shared-pool opt-in.** A market could elect to be backed by a shared pool layered
  on top of the per-domain ledgers. The per-domain isolation is the safe default.

These are additive; the engine's waterfall and Phase 1a funding/governance stand on
their own.
