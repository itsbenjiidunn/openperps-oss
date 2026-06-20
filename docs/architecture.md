# OpenPerps architecture notes

Verified facts about the vendored `percolator` v16 engine and how the OpenPerps
on-chain program maps onto it. Line references are into
`crates/engine/src/v16.rs` at the vendored revision (upstream `051e268`).

## The engine is zero-copy on-chain

The on-chain path is `*Account` POD structs accessed through borrowing views, with
no allocation:

- `MarketGroupV16View<'a, T>` / `…ViewMut` (v16.rs:2056 / 2061) =
  `&MarketGroupV16HeaderAccount` (v16.rs:4325) + `&[Market<T>]` (v16.rs:2028),
  built via `…View::new(header, markets)` (v16.rs:2067 / 2073).
- `PortfolioV16View<'a>` / `…ViewMut` (v16.rs:2085 / 2089) =
  `&PortfolioAccountV16Account` (v16.rs:13416), built via `…View::new(header)`
  (v16.rs:2094 / 2135). The source domains are an **inline** array field
  (`source_domains: [PortfolioSourceDomainV16Account; PORTFOLIO_SOURCE_DOMAIN_CAP]`,
  v16.rs:13427, `CAP = 2 * 16 = 32`), not a separate slice, so the view takes the
  header alone.

Fixed layouts that borrow directly from account data. **This is the production,
on-chain path**, and the reason the engine fits in an SBF program at all.
(`V16_MAX_PORTFOLIO_ASSETS_N = 16` legs per portfolio.)

The legacy runtime Vec adapters are gone from `v16.rs`; the `runtime-vec-api`
Cargo feature remains only as a test/proof gate (`crates/engine/Cargo.toml`) and
is never compiled into the program.

The production operations are methods on the *ViewMut* types, e.g.
`MarketGroupV16ViewMut::deposit_not_atomic(&mut self, account: &mut
PortfolioV16ViewMut, amount: u128)` (v16.rs:12733). The `_not_atomic` suffix is
the engine telling us: **the wrapper owns atomicity, persistence, and
authorization.**

## On-chain account layout

```
Market account data:
  [ OpenPerpsMarketHeader (208) ][ MarketGroupV16HeaderAccount ][ MarketSlot ; N ]
  (MarketSlot = Market<MarketWrapper>)

Portfolio account data (one per user, account-local):
  [ PortfolioAccountV16Account ]   (source domains inline, CAP = 32)
```

Each is a single account whose byte buffer is reinterpreted (zero-copy, via
`bytemuck`). The market account starts with the OpenPerps wrapper header, then the
engine's `MarketGroupV16HeaderAccount`, then the `MarketSlot` (`Market<MarketWrapper>`)
array; the portfolio account is a fixed header with its source domains inline. The
program splits the wrapper header off, builds the matching engine view over the
remaining bytes (market view from `new(header, markets)`, portfolio view from
`new(header)`) and calls the engine method, which mutates in place. Nothing is
serialized or allocated.

`crates/program/src/state.rs::OpenPerpsMarketHeader` (208 bytes,
`MARKET_HEADER_VERSION = 4`) is the OpenPerps wrapper header that precedes the
engine's `MarketGroupV16HeaderAccount` in the market account. It holds the
discriminator, version, oracle kind, and the OpenPerps-specific config the engine
does not model. The engine header is initialized in place (no Vec constructor) via
`MarketGroupV16HeaderAccount::dynamic_market_group_account_len::<MarketWrapper>` and
the `impl MarketGroupV16HeaderAccount` entry point (v16.rs:4372).

## Instruction → engine method map

The program decodes 27 instructions (`instruction.rs`) and dispatches them in
`processor.rs`. The ones that drive engine math go through the zero-copy `*_buffer`
helpers in `state.rs`, which build the views and call the engine:

| Instruction | Engine entry |
|-------------|--------------|
| InitMarket | zero-copy header/slots init (`market_split`, `dynamic_market_group_account_len`) |
| InitPortfolio | zero-copy portfolio PDA init |
| Deposit | `deposit_not_atomic` (v16.rs:12733) |
| Withdraw | `withdraw_buffer` / `withdraw_not_atomic` |
| ActivateMarket | `activate_market_buffer` |
| AccrueAsset | `accrue_asset_buffer` |
| Trade / PlaceOrder | `trade_buffer` |
| PlaceBatchOrder | `batch_trade_buffer` (`execute_batch_with_fee_in_place_not_atomic`) |
| Liquidate | `liquidate_account_not_atomic` |
| ResolveMarket | `resolve_market_not_atomic` |
| CrankRefresh | `crank_refresh_buffer` |
| SettlePnl | `settle_pnl_buffer` |
| CrankOracle | `crank_oracle_buffer` |
| CrankPyth | reads a Pyth `PriceUpdateV2`, then `accrue_asset_buffer` |
| CrankDexSpot | reads the pinned DEX vaults, then `crank_oracle_buffer` |

The remaining instructions are wrapper-side and do no engine math: SPL vault
custody (`CreateVault`, `CreateHouseVault`, `FundHouseVault`, `WithdrawHouseVault`),
oracle plumbing (`PinOraclePool`, `SetDexPool`), config (`SetOracleAuthority`,
`SetDepositCap`), delegation (`SetDelegate`), and test-only helpers
(`CreateMockPool`, `MockSwap`).

## Wrapper responsibilities (what percolator deliberately omits)

- Entrypoint, instruction decode (done: `instruction.rs`, `processor.rs`).
- Account loading + ownership/signer checks + rent/size validation.
- Casting account data to the zero-copy header+slice and constructing views.
- Oracle / funding input authentication.
- Persisting: with zero-copy views, mutations land directly in account data;
  the wrapper just enforces the borrow/commit discipline and CPI for token moves.

## Resolved layout decisions

- Concrete `T` in `Market<T>` on-chain is `MarketWrapper`
  (`MarketSlot = Market<MarketWrapper>`, `state.rs`).
- Byte sizes are fixed and asserted in `state.rs` tests: the wrapper header is 208,
  followed by the engine `MarketGroupV16HeaderAccount`, the `MarketSlot` array, and
  the `PortfolioAccountV16Account` (used for rent and account allocation).
- Header initialization runs in place via
  `MarketGroupV16HeaderAccount::dynamic_market_group_account_len::<MarketWrapper>`,
  never the Vec constructor.
- Collateral custody is an SPL token vault plus CPI, with a separate liquidity vault as
  the counterparty for `PlaceOrder`.
