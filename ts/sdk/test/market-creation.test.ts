import assert from "node:assert/strict";
import test from "node:test";

import { planMarketCreation } from "../src/market-creation.ts";
import type { OpenPerpsMarketCreationIntent } from "../src/intents.ts";

function intentWith(
  patch: Partial<OpenPerpsMarketCreationIntent> = {},
): OpenPerpsMarketCreationIntent {
  return {
    schemaVersion: 1,
    baseMint: "Base111111111111111111111111111111111111111",
    quoteMint: "Quote11111111111111111111111111111111111111",
    symbol: "TEST-PERP",
    initialPrice: "1000000",
    maxLeverage: 5,
    riskTier: "experimental",
    priceProvider: { type: "external", id: "integrator-feed" },
    ...patch,
  };
}

function kinds(intent: OpenPerpsMarketCreationIntent, opts = {}): string[] {
  return planMarketCreation(intent, opts).steps.map((s) => s.kind);
}

test("plan includes the core market creation steps in order", () => {
  const order = kinds(intentWith());
  assert.deepEqual(order, [
    "InitMarket",
    "CreateVault",
    "CreateHouseVault",
    "ActivateMarket",
  ]);
});

test("plan includes FundHouseVault only when lpVault.initialDeposit is present", () => {
  assert.ok(!kinds(intentWith()).includes("FundHouseVault"));
  const funded = kinds(intentWith({ lpVault: { initialDeposit: "50000000" } }));
  assert.ok(funded.includes("FundHouseVault"));
  assert.ok(funded.indexOf("FundHouseVault") < funded.indexOf("ActivateMarket"));
});

test("plan includes CreateMockPool only when requested", () => {
  assert.ok(!kinds(intentWith()).includes("CreateMockPool"));
  assert.ok(kinds(intentWith(), { includeMockPool: true }).includes("CreateMockPool"));
});

test("plan preserves priceProvider.id as oracle binding metadata", () => {
  const plan = planMarketCreation(intentWith());
  assert.equal(plan.oracleBinding.priceProviderId, "integrator-feed");
});
