import assert from "node:assert/strict";
import test from "node:test";

import { planAccrualSteps, planCatchUpAccruals } from "../src/freshness.ts";

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

test("no prior mark pushes the target on every step", () => {
  const steps = planAccrualSteps({
    oldMark: 0n,
    targetMark: 130_000_000n,
    slotLast: 0,
    nowSlot: 2500,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(steps.length, 3); // ceil(2500 / 1000)
  for (const step of steps) assert.equal(step.effectivePrice, 130_000_000n);
});

test("a fast single-step jump is bounded by the per-slot budget", () => {
  // 150 slots behind, one step. budget = 100M * 10bps * 150 / 10000 = 15M, so
  // the 30M jump to the target is clamped to a 15M move (115M, not 130M).
  const steps = planAccrualSteps({
    oldMark: 100_000_000n,
    targetMark: 130_000_000n,
    slotLast: 0,
    nowSlot: 150,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.effectivePrice, 115_000_000n);
});

test("a small move reaches the target in one step", () => {
  // 1M move sits well inside the 15M budget, so the step lands on the target.
  const steps = planAccrualSteps({
    oldMark: 100_000_000n,
    targetMark: 101_000_000n,
    slotLast: 0,
    nowSlot: 150,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.effectivePrice, 101_000_000n);
});

test("a large jump is split into steps that each stay within budget", () => {
  // 2000 slots behind => 2 segments of 1000. maxPriceMoveBpsPerSlot 1 (0.01%)
  // gives a 0.1%-per-segment budget that compounds as the price climbs:
  //   step 1: 100M + (100M * 1 * 1000 / 10000 = 10M) = 110M
  //   step 2: 110M + (110M * 1 * 1000 / 10000 = 11M) = 121M
  // Neither reaches the 10x target, proving the move stays bounded.
  const steps = planAccrualSteps({
    oldMark: 100_000_000n,
    targetMark: 1_000_000_000n,
    slotLast: 0,
    nowSlot: 2000,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 1,
  });
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.effectivePrice, 110_000_000n);
  assert.equal(steps[1]!.effectivePrice, 121_000_000n);
});

test("a downward jump is bounded the same way", () => {
  // 150 slots, one step, budget 15M; the 30M drop to 70M is clamped to 85M.
  const steps = planAccrualSteps({
    oldMark: 100_000_000n,
    targetMark: 70_000_000n,
    slotLast: 0,
    nowSlot: 150,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.effectivePrice, 85_000_000n);
});
