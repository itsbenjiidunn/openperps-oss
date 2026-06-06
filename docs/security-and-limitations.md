# Security And Review Scope

OpenPerps OSS is infrastructure. The Percolator risk engine (`crates/engine`) is
Kani-formally-verified upstream and vendored unmodified. Everything OpenPerps OSS
adds around it (the program wrapper, the SDK, and the keeper) is the scope for
independent review; this doc lists what that review covers, the hardening already
in place, and the open items.

## Review scope

- Solana account validation; signer and authority checks
- PDA derivation and ownership assumptions
- SPL token custody and CPI flows; deposit and withdraw safety
- delegate / session-key permissions
- trade, PnL, funding, and settlement logic; liquidation correctness
- oracle authority, stale price, and manipulation assumptions
- keeper reliability assumptions
- House/LP and insurance vault risk; custom SPL market risk

## Hardening already in place

- The token-less test price source and the raw self-cross trade are test-only:
  `CreateMockPool`, `MockSwap`, and raw `Trade` are excluded from a
  `--no-default-features` build. The standard trade path is
  `PlaceOrder` (user vs House).
- The market header carries a version; a header from an older or future layout
  reads as uninitialized instead of being mis-decoded against stale padding.
- `InitMarket` rejects a `quote_mint` not owned by the SPL Token program.
- DEX-priced markets enforce a per-portfolio collateral cap. The program floor is
  always enforced; a market authority can raise it per market via `SetDepositCap`
  for a market whose pool depth supports larger positions (it can never lower the
  floor, so the backstop cannot be bypassed).
- Pyth cranking (`CrankPyth`) validates the account owner, feed id, Full
  verification, freshness, a confidence-interval bound, and spot/EMA divergence
  before it moves the mark.
- DEX-EWMA cranking (`CrankDexSpot`) prices from real constant-product reserves
  and rejects a pool below a per-market depth floor (`PoolTooThin`).

## Open items

- The operator-controlled oracle path (`AccrueAsset`) sets the mark from a single
  pinned key, rotatable per market via `SetOracleAuthority` without a program
  upgrade. A verifiable feed for every asset is on the roadmap; the Pyth path
  (`CrankPyth`) already provides one for supported feeds.
- DEX-EWMA gates on pool depth; a program-side TWAP is the next layer (pure
  accumulator helpers ship in `dexamm`, the PDA wiring is on the roadmap).
- Custom SPL markets put more on the integrator: price-source quality, LP and
  insurance liquidity, and keeper reliability for liquidation safety.
- Independent third-party review of the wrapper, SDK, and keeper is part of the
  production-hardening roadmap; see [`../SECURITY.md`](../SECURITY.md).
