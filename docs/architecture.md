# OpenPerps architecture notes

Verified facts about the forked `percolator` v16 engine and how the OpenPerps
on-chain program maps onto it. Line references are into
`crates/engine/src/v16.rs` at the forked revision (upstream `323c9f2`).

## The engine has two parallel representations

1. **Runtime / Vec-based**: `MarketGroupV16` (v16.rs:2657), `PortfolioAccountV16`
   (v16.rs:2523), and constructors like `MarketGroupV16::new` (v16.rs:12025).
   These use `Vec` fields and **allocate**. They are gated
   `#[cfg(any(kani, feature = "runtime-vec-api"))]`: **tests and Kani proofs
   only.** Do **not** use them on-chain.

2. **Zero-copy account types**: `*Account` POD structs accessed through views:
   - `MarketGroupV16View<'a, T>` / `…ViewMut` (v16.rs:1849) =
     `&MarketGroupV16HeaderAccount` (v16.rs:4182) + `&[Market<T>]` (v16.rs:1821)
   - `PortfolioV16View<'a>` / `…ViewMut` =
     `&PortfolioAccountV16Account` (v16.rs:11851) +
     `&[PortfolioSourceDomainV16Account]`

   No allocation, fixed layouts that borrow directly from account data. **This
   is the production, on-chain path**, and the reason the engine fits in an SBF
   program at all. (`V16_MAX_PORTFOLIO_ASSETS_N = 16` legs per portfolio.)

The production operations are methods on the *ViewMut* types, e.g.
`MarketGroupV16ViewMut::deposit_not_atomic(&mut self, account: &mut
PortfolioV16ViewMut, amount: u128)` (v16.rs:11171). The `_not_atomic` suffix is
the engine telling us: **the wrapper owns atomicity, persistence, and
authorization.**

## On-chain account layout (target)

```
Market-group account data:
  [ MarketGroupV16HeaderAccount ][ Market<T> ; N ]

Portfolio account data (one per user, account-local):
  [ PortfolioAccountV16Account ][ PortfolioSourceDomainV16Account ; M ]
```

Each is a single account whose byte buffer is reinterpreted (zero-copy, via
`bytemuck`) as a fixed header followed by a slice. The program builds a
`…ViewMut::new(header, slice)` over the borrowed account data and calls the
engine method, which mutates in place. Nothing is serialized or allocated.

`crates/program/src/state.rs::MarketHeader` is a placeholder OpenPerps
discriminator; it will either wrap or be replaced by the engine's
`MarketGroupV16HeaderAccount` once the exact field layout / `Market<T>` concrete
type and the header init entry point (`impl MarketGroupV16HeaderAccount`,
v16.rs:4224) are wired in.

## Instruction → engine method map (planned)

| Instruction | Engine entry (ViewMut method) |
|-------------|-------------------------------|
| InitMarket  | header/markets zero-copy init (see `impl MarketGroupV16HeaderAccount`) |
| Deposit     | `deposit_not_atomic` (v16.rs:11171) |
| Withdraw    | `withdraw_not_atomic` (production view variant) |
| Trade       | trade/open/close view methods |
| Liquidate   | `liquidate_account_not_atomic` |
| Crank       | crank-forward + recovery paths |
| Resolve     | `resolve_market_not_atomic` |

## Wrapper responsibilities (what percolator deliberately omits)

- Entrypoint, instruction decode (done: `instruction.rs`, `processor.rs`).
- Account loading + ownership/signer checks + rent/size validation.
- Casting account data to the zero-copy header+slice and constructing views.
- Oracle / funding input authentication.
- Persisting: with zero-copy views, mutations land directly in account data;
  the wrapper just enforces the borrow/commit discipline and CPI for token moves.

## Open implementation questions (next milestone)

- Concrete `T` in `Market<T>` for on-chain (the engine slot storage type).
- Exact byte sizes of each `*Account` (for account allocation + rent).
- Header initialization entry point that does **not** go through the Vec-based
  `MarketGroupV16::new`.
- Collateral custody: SPL token vault + CPI (the router model from the README).
