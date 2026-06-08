# Risk tiers

A market's **risk tier** is chosen at `InitMarket` (`risk_tier`: 0 = Stable, 1 =
Volatile) and sets the engine config's `(margin, per-slot price clamp, accrual
window)` bundle. It exists because a single config cannot serve both a deep major
and a violent pump-dump token.

## The constraint it works within

The vendored engine's solvency envelope (`validate_exact_solvency_envelope`) binds
the **product** `max_price_move_bps_per_slot * max_accrual_dt_slots` (the
`price_budget`), and the maintenance margin must cover the loss budget that the
price budget feeds. So the three quantities are coupled and cannot be set
independently:

- **Per-slot clamp** = how fast the on-chain mark can track a move.
- **Accrual window** (`max_accrual_dt_slots`) = the max gap between oracle pushes
  before `slot_last` falls behind and trading stale-locks. Smaller window = the
  keeper must push more often.
- **Leverage** = `1 / initial_margin`. Higher leverage = smaller margin = the
  envelope allows a smaller price budget.

Both tiers keep the **same validated price budget** and only rebalance how it is
spent. There is no free lunch: a faster-tracking mark costs either leverage or
keeper push frequency.

## The two tiers

| | Stable | Volatile |
| --- | --- | --- |
| For | deep-pool / major | pump-dump / thin-pool / volatile |
| Max leverage | 10x (`initial_margin` 10%) | 5x (`initial_margin` 20%) |
| Per-slot clamp | 0.1% / slot | 10% / slot |
| Accrual window | 1000 slots (~6.7 min) | 10 slots (~4 s) |
| Keeper push cadence | ~1 / min (cheap) | every few seconds (frequent) |
| Mark behaviour | smooths, lags a violent move | tracks a violent move |

Numbers are derived empirically against the engine's
`validate_public_user_fund_shape` (see the `both_risk_tiers_pass_engine_shape_check`
and `volatile_tier_caps_leverage_at_5x` tests), not hand-computed.

The Volatile tier keeps **high enough leverage to be useful (5x)** and a
**fast-tracking mark** by paying in keeper cost (a push every few seconds). That
push cost is the integrator's to bear; the protocol exposes the capability and does
not compromise it to save cost.

## Choosing a tier: classifying pump-dump risk

You cannot predict a pump-dump event (that is predicting price), but you can
classify a token's fragility. This is an **off-chain** decision (the engine is
crank-forward and cannot scan the market); the operator/app picks the tier at
creation and the protocol enforces the consequences. Core signals:

- **Quote-side depth** (not total TVL): the $ it takes to move price 2%.
- **Liquidity / FDV**: how much of the float the pool can absorb (relative, not
  absolute).
- **Realized volatility**: how violently it has actually moved over a trailing
  window. The strongest empirical signal once history exists.
- **Age**, **LP locked/burned %** (real vs removable depth), **holder
  concentration**, **Pyth feed availability** as context filters.

Rule of thumb: `(thin depth OR low liq/FDV) AND high realized vol -> Volatile`;
deep + low-vol + mature + Pyth-listed -> Stable; anything in between -> Volatile.

**A brand-new launch (e.g. a 0-LP token) has no history and must default to the
conservative tier (Volatile / `MANUAL` oracle).** It graduates as depth grows and
volatility is observed, mirroring the `require_verifiable` ratchet (see
[`oracle-hardening.md`](oracle-hardening.md)).

## Chosen at init; no post-init change

The tier is set at `InitMarket` (before any position exists). The engine has no
post-init config-change entry, and changing the margin/clamp on a market that
already holds positions would re-margin them (a rug vector), so a live tier change
is intentionally not supported. To run a matured token at the Stable tier, create a
new market at that tier; graduating a live market is deferred future work and, if
built, must only tighten risk or act on a flat market.
