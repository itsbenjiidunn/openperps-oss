import assert from "node:assert/strict";
import test from "node:test";

import { classifyMarketTier } from "../src/classify.ts";
import {
  ORACLE_KIND_DEX_EWMA,
  ORACLE_KIND_MANUAL,
  ORACLE_KIND_PYTH,
  RISK_TIER_STABLE,
  RISK_TIER_VOLATILE,
} from "../src/layout.ts";

test("a new launch with no data defaults to Volatile + MANUAL, low confidence", () => {
  const c = classifyMarketTier({});
  assert.equal(c.riskTier, "volatile");
  assert.equal(c.riskTierCode, RISK_TIER_VOLATILE);
  assert.equal(c.oraclePosture, "manual");
  assert.equal(c.suggestedOracleKind, ORACLE_KIND_MANUAL);
  assert.equal(c.confidence, "low");
});

test("a solid major is Stable + verifiable despite a small liquidity/FDV ratio", () => {
  const c = classifyMarketTier({
    quoteDepthUsd: 5_000_000,
    fdvUsd: 1_000_000_000, // liq/FDV = 0.5%, below 2% but it is a major by depth
    realizedVolBpsPerMin: 200,
    ageDays: 400,
    lpLockedPct: 100,
    top10HolderPct: 25,
    hasPythFeed: true,
  });
  assert.equal(c.riskTier, "stable");
  assert.equal(c.riskTierCode, RISK_TIER_STABLE);
  assert.equal(c.oraclePosture, "verifiable");
  assert.equal(c.suggestedOracleKind, ORACLE_KIND_PYTH);
  assert.equal(c.confidence, "high");
});

test("a violent thin new token is Volatile + MANUAL", () => {
  const c = classifyMarketTier({
    quoteDepthUsd: 20_000,
    fdvUsd: 5_000_000,
    realizedVolBpsPerMin: 4_000, // 40% / min
    ageDays: 2,
    lpLockedPct: 10,
    top10HolderPct: 70,
  });
  assert.equal(c.riskTier, "volatile");
  assert.equal(c.oraclePosture, "manual");
  assert.equal(c.suggestedOracleKind, ORACLE_KIND_MANUAL);
});

test("a mid token with a deep locked pool but no Pyth is Stable via DEX_EWMA", () => {
  const c = classifyMarketTier({
    quoteDepthUsd: 250_000,
    fdvUsd: 8_000_000, // liq/FDV ~3.1%, above 2%
    realizedVolBpsPerMin: 500,
    ageDays: 60,
    lpLockedPct: 90,
    top10HolderPct: 30,
    hasPythFeed: false,
  });
  assert.equal(c.riskTier, "stable");
  assert.equal(c.oraclePosture, "verifiable");
  assert.equal(c.suggestedOracleKind, ORACLE_KIND_DEX_EWMA);
});

test("low liquidity/FDV on a non-major forces Volatile even when calm", () => {
  const c = classifyMarketTier({
    quoteDepthUsd: 80_000, // adequate absolute depth, but not a major
    fdvUsd: 50_000_000, // liq/FDV = 0.16%, well below 2%
    realizedVolBpsPerMin: 300,
    ageDays: 90,
    lpLockedPct: 95,
    top10HolderPct: 20,
  });
  assert.equal(c.riskTier, "volatile");
  assert.ok(c.reasons.some((r) => r.includes("liquidity/FDV")));
});

test("thresholds are overridable", () => {
  const signals = {
    quoteDepthUsd: 250_000,
    fdvUsd: 8_000_000,
    realizedVolBpsPerMin: 500,
    ageDays: 60,
    lpLockedPct: 90,
    top10HolderPct: 30,
    hasPythFeed: false,
  };
  // Tightening the vol ceiling below the token's vol flips it to Volatile.
  const c = classifyMarketTier(signals, { maxStableVolBpsPerMin: 100 });
  assert.equal(c.riskTier, "volatile");
});
