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
- DEX-priced markets enforce a per-portfolio collateral cap.

## Known limitations

- The authority-pushed oracle is a single trusted key (see
  [`oracle-and-price-safety.md`](oracle-and-price-safety.md)); rotating it
  currently needs a program upgrade. This is the first mainnet blocker.
- DEX-EWMA has no pool-depth / TWAP check yet.
- The on-chain Pyth CPI is not implemented.
- Custom SPL markets are experimental: integrators own price-source quality, LP
  and insurance liquidity, and keeper reliability for liquidation safety.
- The program wrapper, SDK, and keeper are unaudited.
