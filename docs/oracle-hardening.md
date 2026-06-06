# Oracle Hardening (design)

Status: design for review. Most long-tail oracle safety is per-market
risk-modeling, not a switch in code. This spec covers the two small on-chain
hardenings that make a safe configuration enforceable, plus how the existing
layered defenses compose. The code lands on top of the in-flight House-cap work
(same PDA-flag style), so it is specced here first.

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

## Hardening 1: require-verifiable-feed flag (highest value)

A per-market flag, `require_verifiable_oracle`. When set, `AccrueAsset` (the
authority-set path) is **rejected** for that market: only `CrankPyth` or
`CrankDexSpot` may move the mark. An operator marks a production market as "no
single-key pricing," closing the centralized-relayer manipulation and liveness
risk for that market.

- On-chain: a flag in the market header, or a `[VERIFIABLE_SEED, market]` PDA in
  the `SetHouseCap` / `SetDexPool` style, checked at the top of
  `process_accrue_asset` (reject when the flag is set). Set via a new
  authority-gated `SetRequireVerifiable` instruction, or an `InitMarket` flag.
- It is a config gate, no new math, so it is the cleanest piece to ship.

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

`state.rs` (flag/param), `instruction.rs` (`SetRequireVerifiable` or an
`InitMarket` flag), `processor.rs` (the accrue gate), `error.rs` (a reject
error). These files currently hold the in-flight House-cap work; implement on top
of it once that lands, in the same PDA-flag style.

## Recommendation

Ship **Hardening 1** first: it is the highest-value gate and matches the existing
PDA-flag pattern. Hardening 2 is a parameter. Hardening 3 only once a market
carries both a verifiable feed and a pool.
