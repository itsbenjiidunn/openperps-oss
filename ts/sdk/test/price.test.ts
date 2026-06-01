import assert from "node:assert/strict";
import test from "node:test";

import { createStaticPriceProvider } from "../src/price.ts";
import type { OpenPerpsMarketConfig } from "../src/config.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "test",
  cluster: "devnet",
  programId: "11111111111111111111111111111111",
  market: "11111111111111111111111111111111",
  assetIndex: 0,
  baseMint: "base",
  quoteMint: "quote",
  symbol: "TEST-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "experimental",
  maxLeverage: 5,
  status: "active",
};

test("static price provider returns configured price", async () => {
  const provider = createStaticPriceProvider(123n, "unit-test");
  const result = await provider.getPrice(market);
  assert.equal(result.price, 123n);
  assert.equal(result.source, "unit-test");
  assert.equal(typeof result.timestampMs, "number");
});
