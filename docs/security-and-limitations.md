# Security And Limitations

OpenPerps OSS is infrastructure. The Percolator risk engine (`crates/engine`) is
Kani-formally-verified upstream and vendored unmodified; everything OpenPerps OSS
adds around it (the program wrapper, the SDK, and the keeper) has not had an
independent third-party audit.

## What an audit should cover

- Solana account validation; signer and authority checks
- PDA derivation and ownership assumptions
- SPL token custody and CPI flows; deposit and withdraw safety
- delegate / session-key permissions
- trade, PnL, funding, and settlement logic; liquidation correctness
- oracle authority, stale price, and manipulation assumptions
- keeper reliability assumptions
- House/LP and insurance vault risk; custom SPL market risk

## Hardening already in place

- The devnet-only price toy and the raw self-cross trade are excluded from a
  mainnet build: `CreateMockPool`, `MockSwap`, and raw `Trade` are gated behind a
  default-on `devnet` cargo feature, so a `--no-default-features` build rejects
  them. The production trade path is `PlaceOrder` (user vs House).
- The market header carries a version; a header from an older or future layout
  reads as uninitialized instead of being mis-decoded against stale padding.
- `InitMarket` rejects a `quote_mint` not owned by the SPL Token program.
- DEX-priced markets enforce a per-portfolio collateral cap. The program floor is
  always enforced; a market authority can raise it per market via `SetDepositCap`
  for a market whose pool depth supports larger positions (it can never lower the
  floor, so the backstop cannot be bypassed).

## Known limitations

- The authority-pushed oracle is a single trusted key (see
  [`oracle-and-price-safety.md`](oracle-and-price-safety.md)). It is rotatable per
  market via `SetOracleAuthority` (a `[ORACLE_SEED, market]` PDA) without a program
  upgrade, but a trusted key still sets the price; a trustless feed is the next
  production-hardening item.
- DEX-EWMA has no pool-depth / TWAP check yet.
- Pyth cranking (`CrankPyth`) accrues the mark from a verified `PriceUpdateV2`
  account but does not yet gate on the price confidence interval.
- Custom SPL markets put more on the integrator: price-source quality, LP and
  insurance liquidity, and keeper reliability for liquidation safety.
- Independent third-party review of the wrapper, SDK, and keeper is in scope and
  not yet complete; see [`../SECURITY.md`](../SECURITY.md).
