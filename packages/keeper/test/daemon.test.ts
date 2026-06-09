import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { OpenPerpsMarketConfig } from "@openperps/sdk";

import {
  KEEPER_TIER_PARAMS,
  keeperMarketFromConfig,
  parseRelayerEnv,
  healthResponse,
  startHealthServer,
} from "../src/daemon.ts";
import { createKeeperHealth, recordCrankOk } from "../src/health.ts";

function marketConfig(over: Partial<OpenPerpsMarketConfig> = {}): OpenPerpsMarketConfig {
  return {
    schemaVersion: 1,
    id: "mkt",
    cluster: "devnet",
    programId: "11111111111111111111111111111111",
    market: "11111111111111111111111111111111",
    assetIndex: 0,
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "X-PERP",
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier: "experimental",
    maxLeverage: 5,
    status: "active",
    ...over,
  };
}

// --- keeperMarketFromConfig ---

test("keeperMarketFromConfig maps experimental -> Volatile bounds + fast cadence", () => {
  const m = keeperMarketFromConfig(marketConfig({ riskTier: "experimental" }));
  assert.equal(m.maxAccrualDtSlots, KEEPER_TIER_PARAMS.volatile.maxAccrualDtSlots);
  assert.equal(m.maxPriceMoveBpsPerSlot, KEEPER_TIER_PARAMS.volatile.maxPriceMoveBpsPerSlot);
  assert.equal(m.useOracleAuthorityPda, false);
  assert.equal(m.pushIntervalMs, KEEPER_TIER_PARAMS.volatile.pushIntervalMs);
  assert.ok(m.pushIntervalMs! <= 3_000, "Volatile/memecoin pushes within a few seconds");
});

test("keeperMarketFromConfig maps standard/major -> Stable bounds + slow cadence", () => {
  for (const riskTier of ["standard", "major"] as const) {
    const m = keeperMarketFromConfig(marketConfig({ riskTier }));
    assert.equal(m.maxAccrualDtSlots, KEEPER_TIER_PARAMS.stable.maxAccrualDtSlots);
    assert.equal(m.maxPriceMoveBpsPerSlot, KEEPER_TIER_PARAMS.stable.maxPriceMoveBpsPerSlot);
    assert.equal(m.pushIntervalMs, KEEPER_TIER_PARAMS.stable.pushIntervalMs);
  }
});

test("keeperMarketFromConfig takes pushIntervalMs from config.keeper, then tier", () => {
  // An explicit per-market expectedCrankIntervalMs wins over the tier default.
  const tuned = keeperMarketFromConfig(
    marketConfig({ riskTier: "experimental", keeper: { expectedCrankIntervalMs: 1_000 } }),
  );
  assert.equal(tuned.pushIntervalMs, 1_000);
});

test("keeperMarketFromConfig sets useOracleAuthorityPda when the market pinned one", () => {
  const m = keeperMarketFromConfig(
    marketConfig({ keeper: { oracleAuthority: "11111111111111111111111111111111" } }),
  );
  assert.equal(m.useOracleAuthorityPda, true);
});

test("keeperMarketFromConfig honors overrides", () => {
  const m = keeperMarketFromConfig(marketConfig({ riskTier: "experimental" }), {
    maxAccrualDtSlots: 42,
    maxPriceMoveBpsPerSlot: 7,
    useOracleAuthorityPda: true,
    pushIntervalMs: 1_500,
  });
  assert.equal(m.maxAccrualDtSlots, 42);
  assert.equal(m.maxPriceMoveBpsPerSlot, 7);
  assert.equal(m.useOracleAuthorityPda, true);
  assert.equal(m.pushIntervalMs, 1_500);
});

// --- parseRelayerEnv ---

const baseEnv = {
  OPENPERPS_RPC: "http://127.0.0.1:8899",
  OPENPERPS_KEEPER_KEYPAIR: "/k.json",
  OPENPERPS_MARKETS: "/m.json",
};

test("parseRelayerEnv applies defaults", () => {
  const cfg = parseRelayerEnv({ ...baseEnv });
  assert.equal(cfg.rpc, baseEnv.OPENPERPS_RPC);
  assert.equal(cfg.intervalMs, 60_000);
  assert.equal(cfg.healthPort, 18_810);
  assert.equal(cfg.healthHost, "0.0.0.0");
});

test("parseRelayerEnv parses overrides", () => {
  const cfg = parseRelayerEnv({
    ...baseEnv,
    OPENPERPS_INTERVAL_MS: "3000",
    OPENPERPS_HEALTH_PORT: "9000",
    OPENPERPS_HEALTH_HOST: "127.0.0.1",
  });
  assert.equal(cfg.intervalMs, 3_000);
  assert.equal(cfg.healthPort, 9_000);
  assert.equal(cfg.healthHost, "127.0.0.1");
});

test("parseRelayerEnv requires rpc/keypair/markets", () => {
  assert.throws(() => parseRelayerEnv({}), /OPENPERPS_RPC/);
  assert.throws(
    () => parseRelayerEnv({ OPENPERPS_RPC: "x" }),
    /OPENPERPS_KEEPER_KEYPAIR/,
  );
  assert.throws(
    () => parseRelayerEnv({ OPENPERPS_RPC: "x", OPENPERPS_KEEPER_KEYPAIR: "k" }),
    /OPENPERPS_MARKETS/,
  );
});

test("parseRelayerEnv rejects a non-positive-int interval", () => {
  assert.throws(
    () => parseRelayerEnv({ ...baseEnv, OPENPERPS_INTERVAL_MS: "-5" }),
    /OPENPERPS_INTERVAL_MS/,
  );
  assert.throws(
    () => parseRelayerEnv({ ...baseEnv, OPENPERPS_HEALTH_PORT: "abc" }),
    /OPENPERPS_HEALTH_PORT/,
  );
});

// --- healthResponse ---

test("healthResponse is 200 for a fresh/healthy keeper", () => {
  const r = healthResponse(createKeeperHealth());
  assert.equal(r.status, 200);
  assert.equal(r.body.healthy, true);
  assert.deepEqual(r.body.staleMarkets, []);
});

test("healthResponse is 503 when a market is stale", () => {
  const health = createKeeperHealth();
  recordCrankOk(health, "mkt", {
    slotLast: 10,
    behindSlots: 5000,
    stale: true,
    signature: "sig",
    accruals: 1,
  });
  const r = healthResponse(health);
  assert.equal(r.status, 503);
  assert.equal(r.body.healthy, false);
  assert.deepEqual(r.body.staleMarkets, ["mkt"]);
});

// --- startHealthServer (real socket, ephemeral port) ---

function httpGet(port: number, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }),
      );
    });
    req.on("error", reject);
  });
}

test("startHealthServer serves /health with the right status", async () => {
  const health = createKeeperHealth();
  const server = startHealthServer(health, { port: 0, host: "127.0.0.1" });
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const ok = await httpGet(port, "/health");
    assert.equal(ok.status, 200);
    assert.equal((ok.json as { healthy: boolean }).healthy, true);

    // Make a market stale; the same endpoint now reports 503.
    recordCrankOk(health, "mkt", {
      slotLast: 1,
      behindSlots: 9999,
      stale: true,
      signature: "s",
      accruals: 1,
    });
    const bad = await httpGet(port, "/health");
    assert.equal(bad.status, 503);

    const notFound = await httpGet(port, "/nope");
    assert.equal(notFound.status, 404);
  } finally {
    server.close();
  }
});
