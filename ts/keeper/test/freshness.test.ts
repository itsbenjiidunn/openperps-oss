import assert from "node:assert/strict";
import test from "node:test";

import { planCatchUpAccruals } from "../src/freshness.ts";

test("a fresh asset still gets one accrual", () => {
  const plan = planCatchUpAccruals({ slotLast: 100, nowSlot: 100, maxAccrualDtSlots: 1000 });
  assert.equal(plan.steps, 1);
  assert.equal(plan.behindSlots, 0);
});

test("a slot behind by more than the window bursts multiple accruals", () => {
  const plan = planCatchUpAccruals({ slotLast: 0, nowSlot: 2500, maxAccrualDtSlots: 1000 });
  assert.equal(plan.behindSlots, 2500);
  assert.equal(plan.steps, 3); // ceil(2500 / 1000)
});

test("steps are capped by maxSteps", () => {
  const plan = planCatchUpAccruals({
    slotLast: 0,
    nowSlot: 1_000_000,
    maxAccrualDtSlots: 1000,
    maxSteps: 8,
  });
  assert.equal(plan.steps, 8);
});
