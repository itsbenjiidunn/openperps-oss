# Permission Map

Who may call each instruction, verified against the program handlers.

| Instruction | Who may call | Notes |
| --- | --- | --- |
| `InitMarket` | Permissionless | The signer becomes the market authority recorded in the header. |
| `InitPortfolio` | Owner signer | Creates the owner's portfolio PDA `[PORTFOLIO_SEED, owner, market]`. |
| `Deposit` | Portfolio owner signer | Moves SPL collateral into the vault; engine credits capital. |
| `Withdraw` | Portfolio owner signer | Engine debits first; the vault PDA signs the token transfer out. |
| `PlaceOrder` | Portfolio owner or registered delegate | Production trade path: user vs the market's House PDA. |
| `Trade` | Single authority owning both portfolios | Raw two-account self-cross. Devnet-only: gated out of mainnet builds. |
| `Liquidate` | Permissionless | Engine rejects a healthy account (`NonProgress`). |
| `CrankRefresh` | Permissionless | Re-certifies a portfolio against fresh oracle/funding inputs. |
| `ActivateMarket` | Permissionless | Any signer claims a free (Disabled) slot and activates it with an authenticated price. |
| `AccrueAsset` | Oracle authority moves the mark; any other signer is forced to a delta-0 (stale-clear only) accrual | Only the pinned oracle relayer key may change the price. |
| `CrankOracle` | Permissionless | Reads the slot's pinned pool spot and EWMA-updates the mark (DEX-EWMA markets). |
| `PinOraclePool` | Permissionless, pin-once | Binds a pool to an asset slot; fails if the slot already has one. |
| `ResolveMarket` | Market authority | Checks the header authority; one-way. |
| `CreateVault` | Market authority | Allocates the vault token account at the vault PDA. |
| `CreateHouseVault` | Market authority | One-time; creates the House portfolio PDA. |
| `FundHouseVault` | Market authority | Funds the House/LP counterparty. |
| `WithdrawHouseVault` | Market authority | Engine refuses while the House holds open positions. |
| `SetDelegate` | Portfolio owner signer | Authorizes a session key that can trade but never withdraw. |
| `SettlePnl` | Permissionless | Converts the user's own released PnL into capital; touches no other account. |
| `CreateMockPool` / `MockSwap` | Permissionless, devnet-only | Token-less price toy; gated out of mainnet builds. |

## Oracle authority

In v1 a single pinned relayer key (a program constant) is the only key that may
move a market's mark via `AccrueAsset`. Any other signer is forced to a delta-0
accrual: it can advance freshness (`slot_last`) but cannot change the price.
Making this a rotatable, per-market authority is on the roadmap.
