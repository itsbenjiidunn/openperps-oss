import assert from "node:assert/strict";
import test from "node:test";

import {
  skewFundingRateE9,
  simulate,
  FUNDING_MAX_E9,
  type MarketParams,
} from "../src/economics.ts";
import { balancedChurn, sustainedPumpHold, fastPumpExit } from "../src/scenarios.ts";

const base: MarketParams = {
  houseCapBase: 100_000,
  feeBps: 10,
  houseCapital: 1_000_000,
};

test("skew funding mirrors the on-chain sign + clamp", () => {
  const cap = 1_000;
  assert.equal(skewFundingRateE9(0, cap), 0); // flat -> no funding
  assert.equal(skewFundingRateE9(-cap, cap), FUNDING_MAX_E9); // full short -> +max (longs pay)
  assert.equal(skewFundingRateE9(cap, cap), -FUNDING_MAX_E9); // full long -> -max
  assert.equal(skewFundingRateE9(-cap / 2, cap), FUNDING_MAX_E9 / 2); // proportional
  assert.equal(skewFundingRateE9(-cap * 5, cap), FUNDING_MAX_E9); // saturates
  assert.equal(skewFundingRateE9(-cap, 0), 0); // no cap reference -> no funding
});

test("balanced two-sided churn keeps the House ~flat (no directional bet)", () => {
  const r = simulate(base, balancedChurn({ price: 1, perStepFlow: 1_000, steps: 200 }));
  // The book oscillates around flat, so the House never builds inventory.
  assert.ok(Math.abs(r.endHouseNet) <= 1_000, `net ${r.endHouseNet}`);
  assert.ok(Math.abs(r.inventoryPnl) < 1, "no inventory PnL on a flat price");
  // What's left is the fee the House PAYS minus tiny funding: a small drag, never a gain.
  assert.ok(r.feesPaid > 0);
  assert.ok(r.finalEquity < base.houseCapital, "fees make churn a net cost to the House");
});

test("inventory loss on a one-sided pump is bounded by the House cap", () => {
  const p0 = 1;
  const pEnd = 3;
  const r = simulate(base, sustainedPumpHold({ p0, pEnd, size: 1_000_000, steps: 200 }));
  // size >> cap, so the House is clamped to -cap; max loss = cap * price range.
  const maxLoss = base.houseCapBase * (pEnd - p0);
  assert.ok(r.endHouseNet === -base.houseCapBase, `clamped to -cap, got ${r.endHouseNet}`);
  assert.ok(-r.inventoryPnl <= maxLoss + 1e-6, `loss ${-r.inventoryPnl} <= ${maxLoss}`);
  // Funding income is negligible next to the inventory loss (the key finding).
  assert.ok(
    r.fundingIncome < 0.05 * -r.inventoryPnl,
    `funding ${r.fundingIncome} should be << loss ${-r.inventoryPnl}`,
  );
});

test("fast pump + exit: the House realizes a loss, funding cannot save it", () => {
  const r = simulate(base, fastPumpExit({ p0: 1, pEnd: 2, size: 100_000, rampSteps: 10 }));
  assert.ok(r.endHouseNet === 0, "users closed; House flat again");
  assert.ok(r.finalEquity < base.houseCapital, "House ends down after a fast pump-and-exit");
  assert.ok(r.fundingIncome < 0.01 * -r.inventoryPnl, "no time for funding to accrue");
});

test("counterfactual: a maker fee TO the House flips churn to a yield role", () => {
  // Same balanced churn, but the House earns a 30 bps maker fee on filled notional.
  const withFee: MarketParams = { ...base, feeToHouseBps: 30 };
  const churn = balancedChurn({ price: 1, perStepFlow: 1_000, steps: 200 });
  const off = simulate(base, churn);
  const on = simulate(withFee, churn);
  assert.ok(off.finalEquity < base.houseCapital, "no maker fee -> churn is a drag");
  assert.ok(on.finalEquity > base.houseCapital, "maker fee -> churn earns");
  assert.ok(on.feesEarned > on.feesPaid, "earned > paid once the House keeps a fee");
});
