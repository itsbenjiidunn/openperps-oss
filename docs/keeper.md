# Keeper

`@opp-oss/keeper` is the self-hosted process responsible for core market
safety operations.

V1 responsibilities:

- load multiple market configs
- call price providers
- push oracle/funding updates
- scan for liquidations
- submit liquidation transactions
- log health and errors

V1 does not include:

- analytics dashboard
- candles
- billing
- hosted tenant registry
- full trade feed API
- SLA system

The initial runner is a simple multi-market loop. OI-gated scheduling can come
later.

For `AccrueAsset`, the keeper signer must match the market's pinned oracle authority.
If the signer does not match `keeper.oracleAuthority` / the on-chain authority, the
program rejects the oracle/funding update.

The keeper must push oracle updates frequently enough to respect the engine's
per-slot price-move bound and `max_accrual_dt_slots` freshness window. A large
jump or long gap will be rejected. When a slot has fallen behind, the keeper or
trade path must burst catch-up accruals to clear staleness before risk-increasing
trades succeed. See [keeper-freshness.md](keeper-freshness.md).
