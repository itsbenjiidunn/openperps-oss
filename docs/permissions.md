# Permission Map

Who may call each instruction, verified against the program handlers.

| Instruction | Who may call | Notes |
| --- | --- | --- |
| `InitMarket` | Permissionless | The signer becomes the market authority recorded in the header. |
| `InitPortfolio` | Owner signer | Creates the owner's portfolio PDA `[PORTFOLIO_SEED, owner, market]`. |
| `Deposit` | Portfolio owner signer | Moves SPL collateral into the vault; engine credits capital. |
| `Withdraw` | Portfolio owner signer | Engine debits first; the vault PDA signs the token transfer out. |
| `PlaceOrder` | Portfolio owner or registered delegate | Production trade path: user vs the market's House PDA. |
| `Trade` | Single authority owning both portfolios | Raw two-account self-cross. Test-only, excluded from a `--no-default-features` build. |
| `Liquidate` | Permissionless | Engine rejects a healthy account (`NonProgress`). |
| `CrankRefresh` | Permissionless | Re-certifies a portfolio against fresh oracle/funding inputs. |
| `ActivateMarket` | Permissionless | Any signer claims a free (Disabled) slot and activates it with an authenticated price. |
| `AccrueAsset` | Oracle authority moves the mark; any other signer is forced to a delta-0 (stale-clear only) accrual | Only the pinned oracle relayer key may change the price. |
| `CrankOracle` | Permissionless | Reads the slot's pinned pool spot and EWMA-updates the mark; the pinned pool is a token-less test pool (DEX-EWMA markets). |
| `CrankDexSpot` | Permissionless | Reads the pinned pool's two SPL vault reserves, rejects a pool below the depth floor (`PoolTooThin`), and EWMA-updates the mark (DEX-priced markets). |
| `CrankPyth` | Permissionless | Reads a Pyth `PriceUpdateV2` account (owner, feed id, Full verification, freshness, confidence, and EMA-divergence checked) and accrues the mark (PYTH markets). |
| `PinOraclePool` | Permissionless, pin-once | Binds a pool to an asset slot; fails if the slot already has one. |
| `ResolveMarket` | Market authority | Checks the header authority; one-way. |
| `CreateVault` | Market authority | Allocates the vault token account at the vault PDA. |
| `CreateHouseVault` | Market authority | One-time; creates the House portfolio PDA. |
| `FundHouseVault` | Market authority | Funds the House/LP counterparty. |
| `WithdrawHouseVault` | Market authority | Engine refuses while the House holds open positions. |
| `SetDelegate` | Portfolio owner signer | Authorizes a session key that can trade but never withdraw. |
| `SettlePnl` | Permissionless | Converts the user's own released PnL into capital; touches no other account. |
| `SetOracleAuthority` | Market authority | Sets or rotates the market's oracle authority PDA (a zero key revokes to the constant). |
| `SetDepositCap` | Market authority | Raises the per-portfolio deposit cap on a DEX-priced market above the program floor. |
| `SetDexPool` | Market authority | Binds a DEX-priced market's pool: the two reserve vaults, base decimals, and minimum quote depth (`[DEXPOOL_SEED, market]` PDA). |
| `SetHouseCap` | Market authority | Sets the House exposure cap: the max net House position per asset, base units (`[HOUSE_CAP_SEED, market]` PDA; zero disables it). Enforced in `PlaceOrder` / `PlaceBatchOrder`. |
| `SetRequireVerifiable` | Market authority | Ratchets the market's require-verifiable flag 0 -> 1 (turning it OFF is rejected). When enabled, `AccrueAsset` is forced to a delta-0 accrual so the relayer cannot move the mark; only `CrankPyth` / `CrankDexSpot` price it. `InitMarket` defaults it ON for `PYTH` / `DEX_EWMA` and OFF for `MANUAL`. |
| `FundInsurance` | Permissionless | Transfers quote tokens into the market vault and funds the engine's per-(asset, side) domain insurance via `deposit_domain_insurance_not_atomic`; only ever raises the engine's total insurance `I`. |
| `SetInsuranceParams` | Market authority | Sets the insurance withdrawal floor (on the engine's total insurance `I`) and timelock (`[INSURANCE_CFG_SEED, market]` PDA, created on first use). Both are raise-only (a ratchet). |
| `RequestInsuranceWithdraw` | Market authority | Records a pending domain-insurance withdrawal (amount + unlock slot + (asset, side) domain) if it leaves the floor on `I` intact; no funds move. |
| `ExecuteInsuranceWithdraw` | Market authority | Once the timelock elapses, calls the engine's `withdraw_domain_insurance_not_atomic` and transfers out signed by the market vault PDA, re-checking the floor against the live `I`. |
| `CreateMockPool` / `MockSwap` | Permissionless | Token-less test-only price source; excluded from a `--no-default-features` build. |

## Oracle authority

By default a single pinned relayer key (a program constant) is the only key that
may move a market's mark via `AccrueAsset`. A market authority can override this
per market with `SetOracleAuthority`, which writes a `[ORACLE_SEED, market]` PDA;
when that PDA is passed to `AccrueAsset` and names a non-zero key, only that key
may move the mark. Any other signer is forced to a delta-0 accrual: it can
advance freshness (`slot_last`) but cannot change the price. Markets that never
set a PDA keep working on the relayer constant.

This makes the oracle key rotatable per market without a program upgrade. It is an
operator-controlled path: the pinned key sets the price. The verifiable paths are
`CrankPyth` (reads a Pyth `PriceUpdateV2` account) and `CrankDexSpot` (a real
constant-product pool with a depth floor); see
[`oracle-and-price-safety.md`](oracle-and-price-safety.md).
