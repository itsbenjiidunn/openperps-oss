import assert from "node:assert/strict";
import test from "node:test";

import { planHlpRebalance } from "../src/hlp.ts";

const target20 = { targetBufferBps: 2000 };

test("deploys the excess when the buffer is above target", () => {
  // NAV 100, target 20 in the buffer; buffer 80 -> deploy 60.
  const a = planHlpRebalance(
    { bufferBalance: 80n, houseEquity: 20n, houseHasPositions: false },
    target20,
  );
  assert.deepEqual(a, { action: "deploy", amount: 60n });
});

test("harvests to refill when the buffer is below target and the House is flat", () => {
  // NAV 100, target 20; buffer 5 -> want 15, House has 95 -> harvest 15.
  const a = planHlpRebalance(
    { bufferBalance: 5n, houseEquity: 95n, houseHasPositions: false },
    target20,
  );
  assert.deepEqual(a, { action: "harvest", amount: 15n });
});

test("does not harvest while the House holds positions", () => {
  const a = planHlpRebalance(
    { bufferBalance: 5n, houseEquity: 95n, houseHasPositions: true },
    target20,
  );
  assert.equal(a.action, "none");
});

test("harvest equals the shortfall to target (never exceeds House capital)", () => {
  // NAV 100, target 40; buffer 10 -> want 30, House has 90 -> harvest 30 (<= 90).
  // (want = target - buffer <= NAV - buffer = houseEquity always, so the cap is a
  // defensive bound that never binds through normal NAV math.)
  const a = planHlpRebalance(
    { bufferBalance: 10n, houseEquity: 90n, houseHasPositions: false },
    { targetBufferBps: 4000 },
  );
  assert.deepEqual(a, { action: "harvest", amount: 30n });
});

test("does nothing within the hysteresis band", () => {
  // NAV 100, target 20, band +/- 5; buffer 22 is inside [15, 25].
  const a = planHlpRebalance(
    { bufferBalance: 22n, houseEquity: 78n, houseHasPositions: false },
    { targetBufferBps: 2000, hysteresisBps: 500 },
  );
  assert.equal(a.action, "none");
});

test("skips actions below minActionAmount", () => {
  // Deploy excess is 5, below the 100 minimum.
  const a = planHlpRebalance(
    { bufferBalance: 25n, houseEquity: 75n, houseHasPositions: false },
    { targetBufferBps: 2000, minActionAmount: 100n },
  );
  assert.equal(a.action, "none");
});

test("empty vault is a no-op", () => {
  const a = planHlpRebalance(
    { bufferBalance: 0n, houseEquity: 0n, houseHasPositions: false },
    target20,
  );
  assert.equal(a.action, "none");
});
