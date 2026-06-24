# Insurance LP (InsLP): a second-loss, insurance-backed LP tier

InsLP is a permissionless, tokenized claim on a market's insurance fund, parallel to
but distinct from [HLP](./hlp.md). It gives LPs a second risk tier:

| | HLP | InsLP |
|---|---|---|
| Backs | the House counterparty portfolio | the engine insurance `I` |
| Loss position | first-loss (every trade) | second-loss (only on bankruptcies, after the House and liquidation cannot cover) |
| Earns | the spread + funding | the fee inflow routed to insurance |
| Risk | directional, high frequency | tail, low frequency |

Like HLP, InsLP is a wrapper construct over engine state and does NOT modify the
vendored engine. It adds share accounting on top of the engine's per-(asset, side)
domain insurance, and reuses HLP's virtual-offset share math (proven in `hlp.rs`).

## Mechanism (v1, "Cach A")

- **Capital** lives in the existing market vault (as engine `I`), funded / withdrawn
  on the **canonical domain** (`INSLP_CANONICAL_DOMAIN = 0`, asset 0 / long) via the
  engine's `deposit_domain_insurance` / `withdraw_domain_insurance`. No separate
  buffer (unlike HLP).
- **NAV** = the engine's total insurance `I` (`engine_total_insurance`).
- **Deposit** (`DepositInsLp`, permissionless): transfers quote into the market vault,
  raises `I` on the canonical domain, mints shares = `assets_to_shares(amount_net,
  total_shares, I_before)`. The fee stays in `I` (accrues to NAV), so a round-trip
  loses it. The virtual-share offset means an LP's shares claim ~their own deposit,
  never the authority-seeded floor in other domains.
- **Redeem** (two-step, `RequestRedeemInsLp` -> `ExecuteRedeemInsLp`): priced at the
  execute-time NAV, bounded by (a) the **insurance floor** (the canonical
  `[INSURANCE_CFG_SEED, market]` `min_balance`, if set; `InsuranceFloorBreach`
  otherwise) and (b) the canonical domain's engine budget (the engine refuses to pull
  below it). The `redeem_delay_slots` timelock covers the withdraw-before-loss
  classic, exactly like HLP.
- **Yield** is passive: trading fees route to insurance, so `I` grows and NAV/share
  rises. **Risk**: `I` is drawn on bankruptcies (the engine waterfall), so NAV/share
  falls. Second-loss: insurance is only hit after the House and liquidation cannot
  cover.

## The v1 caveat (documented limitation)

NAV is the **total** `I` but deposits/withdrawals use the **canonical domain**, while
the wrapper cannot read a single domain's budget (the engine keeps it private). So on
a market with insurance in multiple domains, an LP's NAV-based claim can exceed what
the canonical domain can pay at a moment: a redemption is then **temporarily blocked**
(the engine refuses to overdraw the domain) until that domain refills. It never loses
funds and never breaks solvency; it waits. For the common single-asset OpenPerps
market this is minimal. The clean alternative (per-(market, asset, side) InsLP with
NAV = that domain's budget) is deferred; it needs a public per-domain budget reader
and one pool per domain.

## Instructions

`SetInsLpParams` (market authority; creates `[INSLP_SEED, market]` on first use,
sets delay / fee / min deposit), `DepositInsLp`, `RequestRedeemInsLp`,
`ExecuteRedeemInsLp` (all permissionless for the LP). SDK: `insLpConfigPda`,
`insLpPositionPda`, `setInsLpParamsIx`, `depositInsLpIx`, `requestRedeemInsLpIx`,
`executeRedeemInsLpIx`. The config / position byte layouts mirror HLP, so the SDK's
`OFFSET_HLP_*` read InsLP state too. Validated end to end by
`packages/sdk/scripts/inslp-integration.ts` (deposit raises `I` + mints shares; a
redemption past the floor reverts; a floor-respecting redemption pays ~the deposit).
