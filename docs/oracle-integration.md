# Oracle Integration (design)

Design and integration plan for the trustless oracle paths. Part A (Pyth) is
implemented and validated on devnet; Part B (depth- and TWAP-aware DEX-EWMA) is
still a spec. This moves settlement pricing from the trusted relayer key to
verifiable, per-tier sources, intentionally concrete so each part is built and
validated against real accounts.

For current oracle status (what is live / stub / future) see
[`oracle-and-price-safety.md`](oracle-and-price-safety.md).

## Baseline (today)

- `oracle_kind`: `MANUAL(0)`, `PYTH(1)`, `DEX_EWMA(2)`.
- Authority relayer (`AccrueAsset`) is live; the oracle authority is rotatable
  per market (`SetOracleAuthority`). `PYTH` is implemented via `CrankPyth` (Part A).
  `DEX_EWMA` reads a devnet mock pool (gated out of mainnet).
- The engine already enforces a per-slot price-move bound, a freshness window,
  and an EWMA (alpha 0.2). The per-portfolio deposit cap (`SetDepositCap`) bounds
  the profit extractable by manipulating a thin pool.

Manipulation resistance for settlement comes from three layers, of which only
the price source is missing: **(1) a manipulation-resistant price source**
(this doc), (2) the per-slot move bound + freshness (done), (3) the depth-scaled
economic cap (done).

## Part A: Pyth pull-oracle (majors: SOL / BTC / ETH)

**Status: implemented and validated on devnet.** `crates/program/src/pyth.rs`
hand-parses `PriceUpdateV2` (the receiver SDK is not pulled into the SBF build),
with a golden unit test against a real devnet SOL/USD account, and
`packages/sdk/scripts/devnet-pyth.ts` cranks the live feed on-chain. The design
below is what was built, including the step 2 confidence-interval gate (reject
`conf / price` above 2%) and a spot/EMA-divergence gate (reject a spike above
10%). The remaining trustless work is Part B (DEX-EWMA).

Pyth's Solana pull model: a permissionless crank posts a `PriceUpdateV2` account
(owned by the Pyth Receiver program) holding a verified price for a feed id:
`price`, `conf`, `exponent`, `publish_time`, plus an EMA price.

Design:

1. New permissionless instruction `CrankPyth { asset_index }`.
   Accounts: `[writable] market`, `[] price_update` (the `PriceUpdateV2`),
   `[signer] cranker`.
2. Verify: `oracle_kind == PYTH`; the update's `feed_id == wrapper.oracle_feed_id`;
   `publish_time` within a configured max age; `conf / price` within a configured
   bound (reject a too-uncertain price).
3. Convert the Pyth price (`price * 10^exponent`) into the market's `1e6` scale,
   handling the negative exponent, sign, and overflow.
4. Feed the result through the existing accrue path (per-slot move bound +
   freshness; light EWMA optional). No trusted key: the price is attested by the
   posted account, so anyone may crank.

Hard parts / validation needs:

- **Dependency:** `pyth-solana-receiver-sdk` must build under the program's
  Pinocchio / SBF setup. If it conflicts, hand-parse `PriceUpdateV2` (stable
  layout: discriminator + write_authority + verification_level + price_message
  {feed_id, price, conf, exponent, publish_time, prev_publish_time, ema_price,
  ema_conf} + posted_slot). Hand-parsing **requires a real account to validate**.
- **Scale conversion** is fixed-point and must be overflow-safe and exact.
- A wrong parse or conversion mis-prices every settlement → unit-test the math,
  and validate parsing against a **real devnet `PriceUpdateV2`**.

## Part B: DEX-EWMA with pool depth + TWAP (custom SPL tokens)

Goal: price a custom token from a real on-chain AMM, manipulation-resistant.

Design:

1. **Real AMM reader:** replace `mock_pool_spot_price` with a reader for the
   target AMM (recommend Raydium CPMM for simplicity; CLMM has a built-in
   observation oracle but a more complex layout). Read reserves (or sqrt-price)
   from the pool account.
2. **Depth gate:** read the quote reserve as depth; reject or clamp the crank if
   depth is below a configured per-market floor, so a drained or thin pool cannot
   price the market.
3. **TWAP:** price off a time-weighted average, not spot, so a manipulator must
   sustain the move across the window (cost scales with depth x window). Either
   read the AMM's own on-chain TWAP (CLMM observations) or maintain a program-side
   TWAP in a `[TWAP_SEED, market, asset_index]` PDA holding
   {cumulative, last_ts, last_price} (backward-compatible PDA, no layout change).
4. EWMA + move bound + freshness layer on top (already present).

Hard parts / validation needs:

- **AMM layout parsing** is AMM- and version-specific; a wrong parse mis-prices.
  Validate against a **real devnet pool account**.
- **TWAP storage:** prefer a TWAP-state PDA over a slot-layout change.
- **Depth floor + window** are per-market config (a config PDA, same pattern as
  `SetDepositCap`).

## Part C: Oracle failure handling

Define behaviour when a feed is stale, too uncertain, the pool is too thin, or
the pool is unavailable: **reject the crank** (do not write a bad mark). The mark
holds its last good value, and the freshness window eventually stale-locks
risk-increasing trades (users can still close / reduce, never increase). Document
and test this stale-lock path.

## What to build now vs. defer

- **Now (pure, testable, no external account):** the price-scale conversion,
  TWAP accumulation, depth-gate, and staleness / confidence logic as pure
  functions with unit tests. These can ship as a library before the account
  wiring.
- **Needs devnet validation:** the account parsing (`PriceUpdateV2`, AMM layout)
  and the cranks. Build against real accounts and validate before shipping.
- **Pairs with audit:** this is the highest-risk code in the repo; do the account
  wiring in the audit window.

## Environment / decisions required

- A devnet Pyth feed with a posted `PriceUpdateV2` (majors).
- A real devnet AMM pool for the SPL path; decide the AMM target (Raydium CPMM
  recommended first).
- Confirm `pyth-solana-receiver-sdk` builds under Pinocchio/SBF, or commit to
  hand-parsing `PriceUpdateV2`.

## Backward compatibility

All new state uses PDAs (TWAP-state, per-market oracle config) following the
established pattern, so there is no market-header layout change and existing
markets are unaffected. New cranks are new instructions; the relayer
`AccrueAsset` path stays for `MANUAL` and devnet markets.
