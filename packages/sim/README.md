# @opp-oss/sim

A small economic model + simulation of the **liquidity vault / HLP P&L** on a perp market.
It is a research tool (private, not published) that answers the one question the
on-chain mechanics cannot: **does the vault, and so its LPs, actually survive
and earn on real flow, or is it a bounded-loss backstop?**

```bash
npm test   -w @opp-oss/sim   # model invariants
npm run report -w @opp-oss/sim   # break-even table + conclusion
```

## What it models (faithful to the verified engine drivers)

- The vault is the counterparty to every user trade (B-book); its net position
  per asset is the user imbalance, bounded by `SetHouseCap`.
- **Income: skew funding only.** The vault is always the thin side, so it always
  receives funding -- but the on-chain cap (`ORACLE_FUNDING_MAX_E9 = 10` e9/slot)
  is ~0.2%/day at full imbalance, negligible next to a memecoin's moves.
- **Cost 1: inventory mark-to-market** (net short a pumping token, realized when
  the longs close at the top), bounded by the vault cap.
- **Cost 2: the trading fee.** The engine charges both sides and routes it to
  insurance, so the vault *pays* its leg's fee; it does not earn it.

The `feeToHouseBps` knob models a counterfactual the engine does **not** implement
(the vault earning a maker fee/spread), to quantify how much that would change
viability.

## The finding (run `report` for the numbers)

Under the current engine, on one-sided memecoin flow the vault is **not a yield
role -- it is a bounded-loss backstop.** Funding is negligible, the fee is a cost
to the vault, balanced churn bleeds that fee, and a fast pump-and-exit realizes a
real (cap-bounded) loss. The vault cap is the load-bearing protection.

The lever that turns volume into LP yield is **routing a maker fee TO the vault**
(a real spread for taking the unpopular side) -- an engine/wrapper change, not a
parameter tweak. Until then: size the vault cap to a loss you can fund, treat the
vault as a customer-acquisition cost, and monetize at the App/integrator layer
rather than expecting the LP to earn.
