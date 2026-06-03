import assert from "node:assert/strict";
import test from "node:test";

import {
  createKeeperHealth,
  marketBehind,
  isMarketStale,
  summarizeHealth,
  recordCrankOk,
  recordCrankError,
  recordLiquidations,
} from "../src/health.ts";

test("marketBehind never goes negative", () => {
  assert.equal(marketBehind(100, 250), 150);
  assert.equal(marketBehind(300, 250), 0); // ahead → clamped to 0
});

test("isMarketStale fires past the freshness window", () => {
  assert.equal(isMarketStale(900, 1000), false);
  assert.equal(isMarketStale(1000, 1000), false); // exactly at the window
  assert.equal(isMarketStale(1001, 1000), true);
});

test("a fresh health record is healthy with zeroed totals", () => {
  const h = createKeeperHealth();
  assert.deepEqual(h.totals, { cranks: 0, crankFailures: 0, accruals: 0, liquidations: 0 });
  assert.deepEqual(summarizeHealth(h), { healthy: true, staleMarkets: [], failingMarkets: [] });
});

test("a successful crank records state and clears the error streak", () => {
  const h = createKeeperHealth();
  recordCrankError(h, "SOL-PERP", new Error("rpc timeout"));
  assert.equal(h.markets["SOL-PERP"]!.consecutiveFailures, 1);
  assert.equal(h.totals.crankFailures, 1);

  recordCrankOk(h, "SOL-PERP", {
    slotLast: 1000,
    behindSlots: 5,
    stale: false,
    signature: "sig1",
    accruals: 2,
  });
  const m = h.markets["SOL-PERP"]!;
  assert.equal(m.consecutiveFailures, 0);
  assert.equal(m.lastError, undefined);
  assert.equal(m.lastSignature, "sig1");
  assert.equal(m.behindSlots, 5);
  assert.equal(h.totals.cranks, 1);
  assert.equal(h.totals.accruals, 2);
});

test("summarizeHealth flags stale and repeatedly-failing markets", () => {
  const h = createKeeperHealth();
  recordCrankOk(h, "STALE", { slotLast: 0, behindSlots: 5000, stale: true, signature: "s", accruals: 1 });
  for (let i = 0; i < 3; i++) recordCrankError(h, "DOWN", new Error("boom"));
  recordLiquidations(h, 2);

  const s = summarizeHealth(h);
  assert.equal(s.healthy, false);
  assert.deepEqual(s.staleMarkets, ["STALE"]);
  assert.deepEqual(s.failingMarkets, ["DOWN"]);
  assert.equal(h.totals.liquidations, 2);
});
