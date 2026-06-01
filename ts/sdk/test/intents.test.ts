import assert from "node:assert/strict";
import test from "node:test";

import {
  validateMarketCreationIntent,
  validateTradeIntent,
  type OpenPerpsMarketCreationIntent,
  type OpenPerpsTradeIntent,
} from "../src/intents.ts";

test("validateTradeIntent accepts long and short intents", () => {
  const intent: OpenPerpsTradeIntent = {
    schemaVersion: 1,
    marketId: "sol-devnet",
    side: "long",
    size: "1000000",
    maxSlippageBps: 50,
  };
  assert.deepEqual(validateTradeIntent(intent), intent);
  assert.equal(validateTradeIntent({ ...intent, side: "short" }).side, "short");
});

test("validateTradeIntent rejects invalid side", () => {
  assert.throws(
    () => validateTradeIntent({ schemaVersion: 1, marketId: "x", side: "buy", size: "1" }),
    /invalid trade intent side/i,
  );
});

test("validateMarketCreationIntent accepts external price provider", () => {
  const intent: OpenPerpsMarketCreationIntent = {
    schemaVersion: 1,
    baseMint: "Base111111111111111111111111111111111111111",
    quoteMint: "Quote11111111111111111111111111111111111111",
    symbol: "TEST-PERP",
    initialPrice: "1000000",
    maxLeverage: 5,
    riskTier: "experimental",
    priceProvider: {
      type: "external",
      id: "integrator-feed",
    },
  };
  assert.deepEqual(validateMarketCreationIntent(intent), intent);
});
