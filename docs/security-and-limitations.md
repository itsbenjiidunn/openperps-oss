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

- The devnet-only price toy and test handlers are excluded from a production
  build. `production is the default cargo feature`: a plain `cargo build-sbf`
  ships none of `CreateMockPool`, `MockSwap`, raw `Trade`, or the legacy mock
  oracle path `CrankOracle` / `PinOraclePool`; the devnet artifact is built
  explicitly with `--features devnet`. The production price paths are
  `AccrueAsset`, `CrankPyth`, and `CrankDexSpot`; the standard trade path is
  `PlaceOrder` (user vs House). As defense in depth, the mock-pool reader also
  verifies its `OPMKPOOL` discriminator, so no other program-owned account can be
  read as a pool even on a devnet build, and the mock crank refuses any market
  with `require_verifiable = 1`.
- The House vault cannot be drained out from under HLP depositors:
  `WithdrawHouseVault` requires the canonical `[HLP_SEED, market]` config account
  and refuses while LP shares are outstanding, so once LPs are in the House the
  authority must harvest into the buffer and let LPs redeem rather than
  withdrawing the LP-backing capital.
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
- DEX-EWMA cranking (`CrankDexSpot`) prices from real constant-product reserves,
  rejects a pool below a per-market depth floor (`PoolTooThin`), and moves the
  mark off a capped, time-weighted average (a `[TWAP_SEED, market, asset]` PDA) so
  a single-block reserve flash contributes ~0.
- A market authority can set a House exposure cap per market (`SetHouseCap`): the
  max net House position per asset (base units). `PlaceOrder` / `PlaceBatchOrder`
  reject a trade that would push the House past it (de-risking is always allowed),
  so no single asset's move can blow the House regardless of how many users stack
  one side. The trade handlers verify the cap PDA's canonical address, so it
  cannot be bypassed by omitting the account. The keeper also alerts on a House
  that has run low on equity.

## Open items

- The operator-controlled oracle path (`AccrueAsset`) sets the mark from a
  per-market key. A production build has **no shared default relayer key**: each
  market names its own oracle authority via `SetOracleAuthority` (the SDK one-call
  listing does this at creation), rotatable without a program upgrade, so no
  single key governs many markets and a market that never sets one simply has a
  frozen mark rather than trusting a global key. A verifiable feed for every asset
  is on the roadmap; the Pyth path (`CrankPyth`) already provides one for
  supported feeds.
- DEX-EWMA prices off a capped program-side TWAP on top of the pool-depth gate;
  reading an AMM-native price cumulative (e.g. Raydium observations) to drop the
  sampled-spot assumption is the next layer.
- Custom SPL markets put more on the integrator: price-source quality, LP and
  insurance liquidity, and keeper reliability for liquidation safety. Set a
  per-market House exposure cap (`SetHouseCap`) and fund the House adequately.
- Independent third-party review of the wrapper, SDK, and keeper is part of the
  production-hardening roadmap; see [`../SECURITY.md`](../SECURITY.md).
