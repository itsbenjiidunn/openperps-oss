import assert from "node:assert/strict";
import test from "node:test";

import {
  createStaticPriceProvider,
  createLivePriceProvider,
  usdToPriceInt,
  type FetchLike,
} from "../src/price.ts";
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

// --- live price provider (offline, injected fetch) ---

/// Build a FetchLike that maps a URL substring to a JSON body, or a non-ok
/// response when the value is `null` (simulates a source being down / empty).
function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return async (url: string) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (body === null) return { ok: false, async json() { return {}; } };
        return { ok: true, async json() { return body; } };
      }
    }
    return { ok: false, async json() { return {}; } };
  };
}

const dexBody = (priceUsd: string, liq: number, chainId = "solana") => ({
  pairs: [{ chainId, priceUsd, liquidity: { usd: liq } }],
});
const jupBody = (mint: string, price: string) => ({ data: { [mint]: { price } } });

test("usdToPriceInt scales without dropping low-order digits", () => {
  assert.equal(usdToPriceInt(123.456789, 6), 123456789n);
  assert.equal(usdToPriceInt(0.00001234, 6), 12n); // 0.000012 at 6dp
  assert.equal(usdToPriceInt(0.000000789, 9), 789n); // tiny memecoin, 9dp
  assert.equal(usdToPriceInt(100, 0), 100n);
  assert.equal(usdToPriceInt(0, 6), 0n);
  assert.equal(usdToPriceInt(-5, 6), 0n);
  assert.equal(usdToPriceInt(Number.NaN, 6), 0n);
});

test("live provider prices off DexScreener deepest solana pair", async () => {
  const fetchImpl = fakeFetch({
    "dexscreener.com": {
      pairs: [
        { chainId: "ethereum", priceUsd: "999", liquidity: { usd: 1e9 } }, // wrong chain, ignored
        { chainId: "solana", priceUsd: "1.5", liquidity: { usd: 100 } },
        { chainId: "solana", priceUsd: "2.0", liquidity: { usd: 5_000 } }, // deepest wins
      ],
    },
  });
  const provider = createLivePriceProvider({ fetchImpl });
  const r = await provider.getPrice(market);
  assert.equal(r.price, 2_000_000n); // 2.0 at 6dp
  assert.equal(r.source, "dexscreener");
});

test("live provider falls back to Jupiter when DexScreener is empty", async () => {
  const fetchImpl = fakeFetch({
    "dexscreener.com": { pairs: [] }, // no usable pair
    "jup.ag": jupBody(market.baseMint, "0.25"),
  });
  const provider = createLivePriceProvider({ fetchImpl });
  const r = await provider.getPrice(market);
  assert.equal(r.price, 250_000n); // 0.25 at 6dp
  assert.equal(r.source, "jupiter");
});

test("live provider holds last-known when all sources fail", async () => {
  let dexUp = true;
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("dexscreener.com")) {
      if (!dexUp) return { ok: false, async json() { return {}; } };
      return { ok: true, async json() { return dexBody("3.0", 5_000); } };
    }
    return { ok: false, async json() { return {}; } }; // jupiter down too
  };
  const provider = createLivePriceProvider({ fetchImpl });

  const first = await provider.getPrice(market);
  assert.equal(first.price, 3_000_000n);
  assert.equal(first.source, "dexscreener");

  dexUp = false; // both sources now down
  const held = await provider.getPrice(market);
  assert.equal(held.price, 3_000_000n);
  assert.equal(held.source, "dexscreener:last-known");
  assert.equal(held.timestampMs, first.timestampMs); // stale timestamp, not refreshed
});

test("live provider throws when no source and no last-known", async () => {
  const provider = createLivePriceProvider({ fetchImpl: fakeFetch({}) });
  await assert.rejects(() => provider.getPrice(market), /no live price/);
});

test("live provider rejects garbage and skips to next source", async () => {
  const fetchImpl = fakeFetch({
    "dexscreener.com": dexBody("0", 5_000), // non-positive -> rejected
    "jup.ag": jupBody(market.baseMint, "4.2"),
  });
  const provider = createLivePriceProvider({ fetchImpl });
  const r = await provider.getPrice(market);
  assert.equal(r.price, 4_200_000n);
  assert.equal(r.source, "jupiter");
});

test("live provider respects maxPriceUsd", async () => {
  const fetchImpl = fakeFetch({
    "dexscreener.com": dexBody("1000000000000", 5_000), // 1e12, above default 1e9 cap
    "jup.ag": jupBody(market.baseMint, "7"),
  });
  const provider = createLivePriceProvider({ fetchImpl });
  const r = await provider.getPrice(market);
  assert.equal(r.price, 7_000_000n);
  assert.equal(r.source, "jupiter");
});
