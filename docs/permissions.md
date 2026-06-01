# Permission Map

| Instruction | Permission model |
| --- | --- |
| `InitMarket` | Open or configured by market creation flow, depending on deployment policy |
| `InitPortfolio` | Open |
| `Deposit` | Portfolio owner signer |
| `Withdraw` | Portfolio owner signer |
| `Trade` / `PlaceOrder` | Required portfolio owner/delegate signers |
| `Liquidate` | Permissionless; program rejects healthy accounts |
| `CrankRefresh` | Permissionless refresh/protective path |
| `ActivateMarket` | Authority-pinned |
| `AccrueAsset` | Authority-pinned oracle/funding update |
| `ResolveMarket` | Authority-pinned |
| `CreateVault` | Market authority / creation flow |
| `CreateHouseVault` | Market authority / creation flow |
| `FundHouseVault` | Authority-only or configured House/LP funder |
| `WithdrawHouseVault` | Authority-only |
| `SetDelegate` | Portfolio owner signer |
| `SettlePnl` | Portfolio owner/delegate path, according to program guard |

For `AccrueAsset`, the keeper signer must match the market's pinned oracle authority.
If the keeper signs with the wrong key (not `keeper.oracleAuthority` / the on-chain
authority), the program rejects the oracle/funding update.
