# Keeper Freshness

The keeper is part of the risk system, not just a price cron.

For assets with open interest, the engine enforces:

- a per-slot price-move bound
- a `max_accrual_dt_slots` freshness window

Each `AccrueAsset` can only move the price within the configured
`max_price_move_bps_per_slot * dt` budget. If the keeper pushes a large jump or
waits too long, the program can reject the update, including with
`RecoveryRequired`.

If `slot_last` falls too far behind the current slot, risk-increasing trades can
be blocked with `LockActive`.

When a market falls behind, the keeper or trade path must run burst catch-up
accruals to clear staleness before risk-increasing trades succeed.
