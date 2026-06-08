# House LP (HLP): permissionless House vault (design)

Status: Phase 2a + 2b implemented (redemption model A). The full LP cycle is wired:
share/NAV math core (host-tested), `CreateHlpVault`, `SetHlpParams`, `DepositHlp`,
`DeployHlp` (buffer -> engine House via the FundHouseVault path), the two-step
`RequestRedeemHlp` / `ExecuteRedeemHlp` (priced at execute-time NAV, paid from and
bounded by the free buffer), and `HarvestHlp` (engine House -> buffer to refill
redemption liquidity, opportunistic during flat windows). NAV is the buffer balance
plus the House's marked equity, with a configurable `nav_haircut_bps` discount on the
House's positive marked PnL (losses never discounted, so NAV stays conservative on
the dangerous side). Governance is the market authority, which an operator can point
at a multisig/timelock. Remaining: keeper automation that schedules deploy/harvest,
optional secondary share transfer, and the SBF integration test that validates the
handlers at runtime. This documents the mechanism, the share/NAV math, the central
redemption constraint the engine imposes, the options, and the open decisions.

## What it changes, and why it matches the tweet

Today the House (the counterparty to every user trade) is funded by the operator and
its PnL accrues to the operator. HLP makes the House a **permissionless LP vault**:
anyone deposits, receives shares, and the House's PnL (the spread and funding it
earns as counterparty, minus its losses) is distributed pro-rata to LP shareholders.
Keep the mechanism, change who benefits: the rent the House earns returns to users
(the LPs), and the protocol itself takes no cut (an app at the edge charges its own
fee). That is toly's "reduce the rents to marginal and return all rents to users".

## The House is already an engine portfolio

The engine treats the House as one portfolio that takes the opposite side of every
`PlaceOrder`, and its socialization already routes losses to the counterparty side
(the House). So HLP is a **wrapper construct layered on the House portfolio's
capital**: it does not modify the vendored engine. It adds share accounting (who owns
the House capital) on top of a portfolio the engine already manages.

## NAV and shares

- Shares are a pro-rata claim on the House vault's net asset value (NAV).
- **NAV = the House portfolio's conservative (haircut) equity + any free buffer
  capital.** The engine exposes the haircut equity (`account_haircut_equity` /
  `account_equity_from_parts`), which caps unrealizable paper PnL, the right basis so
  a share never over-credits paper gains.
- Deposit: `shares_minted = total_shares == 0 ? amount : floor(amount * total_shares / NAV)`.
- Redeem: `assets_out = floor(shares * NAV / total_shares)`.
- Limited liability: a share's value floors at 0; an LP can never lose more than
  deposited (the engine bounds the House's equity at the portfolio level).

## The central constraint: House capital is locked while positioned

`withdraw_not_atomic` refuses ANY capital withdrawal while the account holds a single
open position (`active_bitmap` non-empty raises `Stale`). The House is the
counterparty to every trade, so it is almost never flat. Therefore **an LP cannot
redeem capital from the engine House on demand.** This is the hard problem and the
central design decision.

Deposit is the easy direction (adding capital only improves health; no zero-legs
rule). Redemption is the constrained one.

### Redemption options

- **(A) Free-buffer vault (recommended).** A separate HLP token account holds
  undeployed capital. Deposits land in the buffer; a keeper sweeps the buffer into
  the engine House when it needs margin; redemptions are paid from the buffer.
  Withdrawals are bounded by the free (unutilized) buffer, exactly how mature
  utilization-bounded HLPs behave. `NAV = engine House equity + buffer`. Cost: a
  second vault plus sweep/harvest machinery.
- **(B) Deposit-matched redemption.** No buffer; a redemption is paid from incoming
  deposits (a new depositor funds the exiter), or via engine withdraw when the House
  happens to be flat. Simpler (no second vault), but redemption liquidity depends on
  deposit flow or flat windows (best-effort, can queue indefinitely).
- **(C) De-risking redemption.** A keeper reduces House exposure (closes positions)
  to free capital, then withdraws. Most market-impacting and complex; needs a
  counterparty to take the other side.

All three share the same truth: HLP redemption is liquidity-constrained because House
capital is locked while positioned. (A) makes the constraint explicit and
predictable, and matches how real HLPs work.

## Fee / rent return

The House's PnL (the spread and funding it earns as counterparty) accrues to its
equity, then to NAV, then to LP shares. No protocol cut. An integrator at the edge
charges its own fee (out of scope). That is the marginal-rent, returned-to-users
model.

## Solvency

- The engine maintains the House portfolio's solvency and socialization
  (`V >= C_tot + I`, the bankruptcy domains). HLP does not touch this; it only
  accounts for who owns the House capital.
- The House cap (`SetHouseCap`) bounds per-asset House exposure, so it bounds LP
  drawdown from any one asset's move.
- A guarded launch caps LP deposits low at first.
- The authority cannot drain LP-backing capital: `WithdrawHouseVault` is refused
  while HLP shares are outstanding (it requires the canonical HLP config account
  and rejects when `total_shares > 0`). To take profit the authority harvests into
  the buffer and lets LPs redeem, rather than withdrawing the House.
- Authority seed funded via `FundHouseVault` is share-less: it counts toward House
  equity and so toward NAV, benefiting existing LP shares. For clean accounting an
  authority that wants its seed to be its own claim should deposit through HLP
  (minting shares) rather than `FundHouseVault`.

## Attack surface (the LP-vault classics)

- **NAV manipulation / sandwich:** deposit or redeem at a stale or gameable NAV to
  extract value. Mitigate with NAV from the fair on-chain mark (not raw spot), a
  redemption delay (shares priced at execution, not request, reusing the insurance
  timelock pattern), and a deposit/withdraw fee that makes round-tripping
  unprofitable.
- **First-depositor share inflation:** the classic empty-vault rounding attack.
  Mitigate with a minimum initial deposit and seeded dead shares.
- **Withdraw-before-loss:** an LP redeeming just before an adverse mark move; the
  redemption delay covers this too.

## Phasing

- **2a.** HLP config + shares + NAV read + deposit + buffer-bounded redemption
  (option A) + the LP-vault mitigations (min deposit, redemption delay, fee).
- **2b.** Keeper automation: sweep (buffer to engine House) and harvest (realized
  House PnL to buffer).
- **2c.** Governance (who sets fees / caps), optional secondary share transfer.

## Open decisions (for review)

1. **Redemption model: (A) free-buffer vault, (B) deposit-matched, or (C)
   de-risking.** Recommend (A). This shapes everything else.
2. **NAV basis: haircut (conservative) equity.** Recommended; confirm.
3. **Redemption delay length + deposit/withdraw fee** (the anti-sandwich knobs).
4. **Per-market HLP vs one shared HLP.** Per-market isolates risk and is consistent
   with the isolated-House and per-domain-insurance model. Recommend per-market.
