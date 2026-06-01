# Position Lifecycle

The high-level user path is:

1. open position against House/LP
2. oracle/keeper moves mark price
3. close position
4. settle realized PnL into withdrawable capital
5. withdraw available capital

Profitable realized PnL must be settled into capital before it is withdrawable.
The engine converts released/realized PnL into capital via `SettlePnl`
(`convert_released_pnl_to_capital`), so high-level SDK helpers such as
`closePosition` and `withdraw` should either guide or compose this flow
explicitly rather than presenting close and withdraw as unrelated buttons.

## Trade resolution guards

`resolveTradeIntent` enforces the SDK-side guards before a trade is built:

- a House/LP counterparty must be configured (official markets use the shared
  House, custom markets use the creator's House)
- the execution price comes from keeper-certified/on-chain mark state, never a
  client or chart price
- `limitPrice` rejects an execution price outside the user's guard
- `maxSlippageBps` rejects an execution price too far from the reference price
- `reduceOnly` rejects an order that would open or increase exposure

## Lifecycle test requirement

Before claiming the high-level close/withdraw flow complete, add an integration
test that opens versus House, moves price into profit through the oracle/keeper
path, closes, settles PnL, withdraws, and asserts portfolio/vault balances
changed as expected.
