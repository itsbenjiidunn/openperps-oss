# Oracle Hardening (design)

Status: Hardening 1 and 2 are implemented; Hardening 3 is design. Most long-tail
oracle safety is per-market risk-modeling, not a switch in code. This spec covers
the small on-chain hardenings that make a safe configuration enforceable, plus how
the existing layered defenses compose.

## Context

Three oracle kinds price a market:

- **`MANUAL` (`AccrueAsset`)**: an authority relayer signs the mark on-chain,
  bounded by the per-slot move clamp and freshness window. One key sets the price.
- **`PYTH` (`CrankPyth`)**: reads the Pyth receiver's verified `PriceUpdateV2`
  account, gated on confidence and spot/EMA divergence.
- **`DEX_EWMA` (`CrankDexSpot`)**: reads a real constant-product pool, folds it
  into a capped TWAP, bounded by the depth floor, per-slot clamp, and deposit cap.

The risk for "perps on any token": most long-tail tokens have no Pyth feed, so
they fall to `DEX_EWMA` off a possibly-thin pool, or to `MANUAL`. A production
market should not be priced by a single authority key, and a market on a thin
pool needs tight caps.

## Hardening 1 / P1: require-verifiable flag, default + ratchet (implemented)

A per-market `require_verifiable` flag in the market header. When set,
`process_accrue_asset` forces the non-oracle (delta-0) path: the authority's
requested price is ignored and the current mark re-asserted, so the relayer key can
never move the mark and only `CrankPyth` / `CrankDexSpot` price it. This closes the
centralized-relayer manipulation and liveness risk for that market.

**Default by oracle kind (the trust tier).** `InitMarket` defaults the flag from
`oracle_kind`, so a market self-describes its pricing trust tier:

- `PYTH` / `DEX_EWMA` (has a verifiable source) -> default **ON** (verifiable
  tier): neutral, no single key can move the mark.
- `MANUAL` (no verifiable source) -> default **OFF** (relayer tier): the explicit
  opt-out for long-tail / no-feed / 0-LP listings, priced by the relayer.

**Ratchet.** `SetRequireVerifiable` only moves the flag 0 -> 1; turning it back OFF
is rejected (`VerifiableCannotDowngrade`). A market's pricing trust can only ever
strengthen, never silently revert to a single relayer key. The natural lifecycle
(list `MANUAL`, graduate to verifiable once a pool/feed is deep enough) runs in the
allowed direction.

**Tier guidance for volatile / pump-dump tokens.** The verifiable `DEX_EWMA` mark
is deliberately smoothed (TWAP + EWMA + per-slot clamp) to resist thin-pool
manipulation, which makes it **lag a violent move**, late liquidations and bad-debt
risk on a real pump/dump, and a thin pool can fail the depth floor and stop
pricing. So a volatile / thin-pool token should be listed `MANUAL` (the relayer can
track a Jupiter-aggregated price), and only graduated to verifiable once its pool is
deep enough that the TWAP lag is tolerable. The default leaves `MANUAL` markets on
the relayer, so "long-short any token" including violent movers is unaffected.

- The flag lives in the market header (a repurposed reserved byte, so the layout
  and `MARKET_HEADER_VERSION` are unchanged), and the gate reads it from the market
  account the handler already loads, so there is no extra account to omit or
  substitute.
- It forces a delta-0 accrual rather than rejecting, so the permissionless
  stale-clear the trade flow relies on (which only advances `slot_last`) keeps
  working.
- It is a config gate, no new math.

## Hardening 2: stale-pause parameter (implemented)

The engine's freshness window already raises `LockActive`, which blocks
**risk-increasing** trades when the mark is stale (de-risking stays allowed, which
is correct, since trapping users who want out is worse). Hardening 2 adds a
per-market `max_staleness_pause_slots` knob (in the `MarketRiskConfig` /
`SetRiskConfig` PDA) that the trade handlers enforce: once the mark's `slot_last`
is more than that many slots behind the current slot, a **new** risk-increasing
trade is rejected (`OracleMarkStale`), while de-risking stays allowed. It is a
per-market tightening of the engine freshness gate, applies to ALL oracle modes
(MANUAL / DEX-EWMA / PYTH), and 0 disables it (rely on the engine window).

## Hardening 3 (optional): cross-source divergence band

For markets that have **both** a Pyth feed and a DEX pool, reject a
`CrankDexSpot` mark that diverges more than a configured band from the Pyth
reference. This sanity-checks DEX manipulation against the verifiable feed. It
only applies where both sources exist (majors with a DEX pool), so the coverage
is limited; it is a later layer, not a long-tail fix.

## What is not a code fix

For a long-tail token with no verifiable feed, safety reduces to **pool depth
plus the caps** (deposit cap, vault cap, per-slot clamp, TWAP). That is
per-market risk-modeling: the operator sizes the caps to the pool's real depth
and the asset's volatility. The hardenings above make the safe configuration
**enforceable**; choosing the parameters is risk-engineering, not a switch.

## Where the code lands

Hardening 1 lives in `state.rs` (the `require_verifiable` header flag plus its
reader/writer), `instruction.rs` (`SetRequireVerifiable`), and `processor.rs`
(`process_set_require_verifiable` and the one-line gate in `process_accrue_asset`),
with the SDK `setRequireVerifiableIx`. Hardening 2 lives in `state.rs`
(`max_staleness_pause_slots` in `MarketRiskConfig`, the `asset_slot_last` reader)
and `processor.rs` (the gate in `enforce_position_caps`, fed the clock and the
asset's `slot_last`), set via `SetRiskConfig`. Hardening 3 (the divergence band in
`process_crank_dex_spot`) remains.

## Recommendation

Hardening 1 and 2 shipped. Hardening 3 only matters once a market carries both a
verifiable feed and a pool (majors with a DEX pool), so it is a later layer, not a
long-tail fix.
