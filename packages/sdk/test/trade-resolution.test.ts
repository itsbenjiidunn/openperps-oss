import assert from "node:assert/strict";
import test from "node:test";

import { resolveTradeIntent } from "../src/trade-resolution.ts";
import type { OpenPerpsMarketConfig } from "../src/config.ts";
import type { OpenPerpsTradeIntent } from "../src/intents.ts";

function marketWith(riskTier: OpenPerpsMarketConfig["riskTier"]): OpenPerpsMarketConfig {
  return {
    schemaVersion: 1,
    id: "mkt",
    cluster: "devnet",
    programId: "11111111111111111111111111111111",
    market: "11111111111111111111111111111111",
    assetIndex: 0,
    baseMint: "base",
    quoteMint: "quote",
    symbol: "MKT-PERP",
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier,
    maxLeverage: 10,
    status: "active",
  };
}

const baseIntent: OpenPerpsTradeIntent = {
  schemaVersion: 1,
  marketId: "mkt",
  side: "long",
  size: "1000000",
};

const house = { housePortfolio: "House1111111111111111111111111111111111111" };

test("resolves a valid trade against the counterparty", () => {
  const resolved = resolveTradeIntent({
    intent: baseIntent,
    market: marketWith("major"),
    counterparty: house,
    executionPrice: 100_000_000n,
  });
  assert.equal(resolved.housePortfolio, house.housePortfolio);
  assert.equal(resolved.executionPrice, 100_000_000n);
});

test("official market requires a configured counterparty", () => {
  assert.throws(
    () =>
      resolveTradeIntent({
        intent: baseIntent,
        market: marketWith("major"),
        executionPrice: 100_000_000n,
      }),
    /no House\/LP counterparty/i,
  );
});

test("custom market requires a configured counterparty", () => {
  assert.throws(
    () =>
      resolveTradeIntent({
        intent: baseIntent,
        market: marketWith("experimental"),
        executionPrice: 100_000_000n,
      }),
    /no House\/LP counterparty/i,
  );
});

test("limitPrice rejects an execution price outside the guard", () => {
  assert.throws(
    () =>
      resolveTradeIntent({
        intent: { ...baseIntent, limitPrice: "99000000" },
        market: marketWith("major"),
        counterparty: house,
        executionPrice: 100_000_000n, // above the long limit
      }),
    /exceeds long limitPrice/i,
  );
});

test("maxSlippageBps rejects an execution price outside tolerance", () => {
  assert.throws(
    () =>
      resolveTradeIntent({
        intent: { ...baseIntent, maxSlippageBps: 50 }, // 0.5%
        market: marketWith("major"),
        counterparty: house,
        referencePrice: 100_000_000n,
        executionPrice: 102_000_000n, // 2% away
      }),
    /exceeds maxSlippageBps/i,
  );
});

test("reduceOnly rejects when the intent would increase exposure", () => {
  assert.throws(
    () =>
      resolveTradeIntent({
        intent: { ...baseIntent, reduceOnly: true },
        market: marketWith("major"),
        counterparty: house,
        executionPrice: 100_000_000n,
        position: { side: "long", size: "1000000" }, // same side as the order
      }),
    /reduceOnly trade would open or increase exposure/i,
  );
});
