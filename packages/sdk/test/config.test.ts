import assert from "node:assert/strict";
import test from "node:test";

import {
  createJsonMarketRegistry,
  validateMarketConfig,
  type OpenPerpsMarketConfig,
} from "../src/config.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "sol-devnet",
  cluster: "devnet",
  programId: "11111111111111111111111111111111",
  market: "11111111111111111111111111111111",
  assetIndex: 0,
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "11111111111111111111111111111111",
  symbol: "SOL-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "major",
  maxLeverage: 10,
  status: "active",
};

test("validateMarketConfig accepts a valid v1 market config", () => {
  assert.deepEqual(validateMarketConfig(market), market);
});

test("validateMarketConfig rejects unsupported schema versions", () => {
  assert.throws(
    () => validateMarketConfig({ ...market, schemaVersion: 2 } as unknown),
    /unsupported market config schemaVersion/i,
  );
});

test("json registry lists and fetches markets by id", async () => {
  const registry = createJsonMarketRegistry([market]);
  assert.deepEqual(await registry.listMarkets(), [market]);
  assert.deepEqual(await registry.getMarket("sol-devnet"), market);
  assert.equal(await registry.getMarket("missing"), null);
});
