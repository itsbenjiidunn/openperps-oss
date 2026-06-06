# Oracle Hardening (design)

Status: Hardening 1 is implemented; Hardening 2 and 3 are design. Most long-tail
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

## Hardening 1: require-verifiable flag (implemented)

A per-market `require_verifiable` flag in the market header, set by the
authority-gated `SetRequireVerifiable` instruction. When set, `process_accrue_asset`
forces the non-oracle (delta-0) path: the authority's requested price is ignored
and the current mark re-asserted, so the authority key can never move the mark and
only `CrankPyth` / `CrankDexSpot` price it. An operator marks a production market
as "no single-key pricing," closing the centralized-relayer manipulation and
liveness risk for that market.

- The flag lives in the market header (a repurposed reserved byte, so the layout
  and `MARKET_HEADER_VERSION` are unchanged), and the gate reads it from the market
  account the handler already loads, so there is no extra account to omit or
  substitute.
- It forces a delta-0 accrual rather than rejecting, so the permissionless
  stale-clear the trade flow relies on (which only advances `slot_last`) keeps
  working. Off by default, so every existing market is unchanged.
- It is a config gate, no new math.

## Hardening 2: stale-pause parameter

Partly present: the engine's freshness window already raises `LockActive`, which
blocks **risk-increasing** trades when the mark is stale (de-risking stays
allowed, which is correct, since trapping users who want out is worse). The
addition is a per-market `max_staleness_pause_slots` that, once exceeded,
requires a fresh oracle update before any **new** position. This is a parameter
on the existing freshness gate, not new logic. Keep de-risking allowed throughout.

## Hardening 3 (optional): cross-source divergence band

For markets that have **both** a Pyth feed and a DEX pool, reject a
`CrankDexSpot` mark that diverges more than a configured band from the Pyth
reference. This sanity-checks DEX manipulation against the verifiable feed. It
only applies where both sources exist (majors with a DEX pool), so the coverage
is limited; it is a later layer, not a long-tail fix.

## What is not a code fix

For a long-tail token with no verifiable feed, safety reduces to **pool depth
plus the caps** (deposit cap, House cap, per-slot clamp, TWAP). That is
per-market risk-modeling: the operator sizes the caps to the pool's real depth
and the asset's volatility. The hardenings above make the safe configuration
**enforceable**; choosing the parameters is risk-engineering, not a switch.

## Where the code lands

Hardening 1 lives in `state.rs` (the `require_verifiable` header flag plus its
reader/writer), `instruction.rs` (`SetRequireVerifiable`), and `processor.rs`
(`process_set_require_verifiable` and the one-line gate in `process_accrue_asset`),
with the SDK `setRequireVerifiableIx`. Hardening 2 (a `max_staleness_pause_slots`
parameter on the engine config) and Hardening 3 (the divergence band in
`process_crank_dex_spot`) remain.

## Recommendation

Hardening 1 shipped. Hardening 2 is a parameter on the existing freshness gate;
Hardening 3 only once a market carries both a verifiable feed and a pool.
