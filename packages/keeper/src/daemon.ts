/// Runnable relayer daemon. The keeper library already cranks oracle/funding and
/// liquidations; this wires it into a process you can deploy: it defaults the
/// price source to the SDK live provider (DexScreener then Jupiter), derives each
/// market's catch-up bounds from its risk tier, serves a `/health` endpoint, and
/// runs until aborted. The result is the missing piece for "list a token, then a
/// live mark flows on-chain" without writing the loop yourself.
///
/// The reusable pieces here are pure or thin and unit-tested; `src/bin/relayer.ts`
/// is the CLI that loads a keypair + a markets file from the environment and
/// calls `runRelayer`.

import { createServer, type Server } from "node:http";

import type { Connection, Keypair } from "@solana/web3.js";
import {
  createLivePriceProvider,
  type OpenPerpsMarketConfig,
  type PriceProvider,
} from "@openperps/sdk";

import { runKeeper } from "./keeper.ts";
import { createKeeperHealth, summarizeHealth, type KeeperHealth } from "./health.ts";
import type { KeeperDeps, KeeperLogLevel, KeeperMarket } from "./types.ts";

/// Per-tier catch-up bounds + crank cadence, matching the program's
/// `default_market_config`. Volatile widens the per-slot price-move clamp,
/// shortens the freshness window, and pushes FAST (so its mark tracks the live
/// price and a memecoin's stale-mark gap stays a couple of seconds, not a minute,
/// shrinking the latency-arbitrage surface); Stable is the slow, cheap tier.
export const KEEPER_TIER_PARAMS = {
  stable: { maxAccrualDtSlots: 1_000, maxPriceMoveBpsPerSlot: 10, pushIntervalMs: 60_000 },
  volatile: { maxAccrualDtSlots: 10, maxPriceMoveBpsPerSlot: 1_000, pushIntervalMs: 2_000 },
} as const;

export type KeeperMarketOverrides = Partial<
  Pick<
    KeeperMarket,
    "maxAccrualDtSlots" | "maxPriceMoveBpsPerSlot" | "useOracleAuthorityPda" | "pushIntervalMs"
  >
>;

/// Build a `KeeperMarket` from a market config: map the off-chain risk tier
/// ("experimental" -> Volatile, otherwise Stable) to the on-chain catch-up
/// bounds and the crank cadence (Volatile ~2s, Stable ~60s), and pass the
/// oracle-authority PDA when the market pinned one. Any field can be overridden.
export function keeperMarketFromConfig(
  config: OpenPerpsMarketConfig,
  overrides: KeeperMarketOverrides = {},
): KeeperMarket {
  const tier = config.riskTier === "experimental" ? "volatile" : "stable";
  const params = KEEPER_TIER_PARAMS[tier];
  return {
    config,
    maxAccrualDtSlots: overrides.maxAccrualDtSlots ?? params.maxAccrualDtSlots,
    maxPriceMoveBpsPerSlot: overrides.maxPriceMoveBpsPerSlot ?? params.maxPriceMoveBpsPerSlot,
    useOracleAuthorityPda:
      overrides.useOracleAuthorityPda ?? config.keeper?.oracleAuthority !== undefined,
    pushIntervalMs:
      overrides.pushIntervalMs ?? config.keeper?.expectedCrankIntervalMs ?? params.pushIntervalMs,
  };
}

export type RelayerEnv = {
  rpc: string;
  keypairPath: string;
  marketsPath: string;
  intervalMs: number;
  healthPort: number;
  healthHost: string;
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/// Parse the relayer's environment into a validated config. Required:
/// `OPENPERPS_RPC`, `OPENPERPS_KEEPER_KEYPAIR` (path to a keypair json), and
/// `OPENPERPS_MARKETS` (path to a market-config json or json array). Optional:
/// `OPENPERPS_INTERVAL_MS` (default 60000), `OPENPERPS_HEALTH_PORT` (18810),
/// `OPENPERPS_HEALTH_HOST` (0.0.0.0).
export function parseRelayerEnv(env: Record<string, string | undefined>): RelayerEnv {
  const rpc = env.OPENPERPS_RPC;
  if (!rpc) throw new Error("OPENPERPS_RPC is required");
  const keypairPath = env.OPENPERPS_KEEPER_KEYPAIR;
  if (!keypairPath) {
    throw new Error("OPENPERPS_KEEPER_KEYPAIR is required (path to a keypair json)");
  }
  const marketsPath = env.OPENPERPS_MARKETS;
  if (!marketsPath) {
    throw new Error("OPENPERPS_MARKETS is required (path to a market-config json)");
  }
  return {
    rpc,
    keypairPath,
    marketsPath,
    intervalMs: parsePositiveInt(env.OPENPERPS_INTERVAL_MS, 60_000, "OPENPERPS_INTERVAL_MS"),
    healthPort: parsePositiveInt(env.OPENPERPS_HEALTH_PORT, 18_810, "OPENPERPS_HEALTH_PORT"),
    healthHost: env.OPENPERPS_HEALTH_HOST ?? "0.0.0.0",
  };
}

/// Map the live health record to an HTTP status + body: 200 when healthy, 503
/// when any market is stale or has a failure streak. Pure, so it is unit-tested
/// without a socket.
export function healthResponse(health: KeeperHealth): {
  status: number;
  body: Record<string, unknown>;
} {
  const summary = summarizeHealth(health);
  return {
    status: summary.healthy ? 200 : 503,
    body: {
      healthy: summary.healthy,
      staleMarkets: summary.staleMarkets,
      failingMarkets: summary.failingMarkets,
      uptimeMs: Date.now() - health.startedMs,
      totals: health.totals,
      markets: health.markets,
    },
  };
}

export type HealthServerOptions = { port: number; host?: string };

/// Serve `healthResponse(health)` as JSON on `GET /health` (and `/`). Returns the
/// server so the caller can close it on shutdown. Use port 0 for an ephemeral
/// port (tests).
export function startHealthServer(health: KeeperHealth, options: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      const { status, body } = healthResponse(health);
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  server.listen(options.port, options.host ?? "0.0.0.0");
  return server;
}

export type RelayerConfig = {
  connection: Connection;
  /// The oracle-authority keypair; must satisfy each market's pinned authority.
  authority: Keypair;
  markets: KeeperMarket[];
  intervalMs?: number;
  /// Price source. Defaults to the SDK live provider (DexScreener then Jupiter),
  /// which prices any token with no Pyth feed (custom SPL, memecoins).
  priceProvider?: PriceProvider;
  /// Health/metrics record. A fresh one is created when omitted.
  health?: KeeperHealth;
  /// When set, serve `/health` on this port/host for the duration of the run.
  healthServer?: HealthServerOptions;
  log?: (level: KeeperLogLevel, message: string, extra?: unknown) => void;
  signal?: AbortSignal;
};

function consoleLog(level: KeeperLogLevel, message: string, extra?: unknown): void {
  const line = `[relayer] ${message}`;
  if (level === "error") console.error(line, extra ?? "");
  else console.log(line);
}

/// Run the relayer: wire the live price provider into the keeper crank loop,
/// optionally serve `/health`, and crank every market until `signal` aborts. The
/// health server is closed when the loop ends.
export async function runRelayer(config: RelayerConfig): Promise<void> {
  const health = config.health ?? createKeeperHealth();
  const priceProvider = config.priceProvider ?? createLivePriceProvider();
  const log = config.log ?? consoleLog;
  const deps: KeeperDeps = {
    connection: config.connection,
    authority: config.authority,
    priceProvider,
    health,
    log,
  };

  let server: Server | undefined;
  if (config.healthServer) {
    server = startHealthServer(health, config.healthServer);
    log(
      "info",
      `health endpoint on http://${config.healthServer.host ?? "0.0.0.0"}:${config.healthServer.port}/health`,
    );
  }

  // The loop ticks at the fastest market's cadence (floored at 1s) so a Volatile
  // market actually gets cranked on its short interval; each market is then
  // throttled to its own `pushIntervalMs` inside the loop. An explicit
  // `config.intervalMs` participates as one more candidate.
  const cadences = config.markets
    .map((m) => m.pushIntervalMs)
    .filter((x): x is number => typeof x === "number");
  if (config.intervalMs !== undefined) cadences.push(config.intervalMs);
  const baseTick = cadences.length > 0 ? Math.max(1_000, Math.min(...cadences)) : 60_000;

  try {
    await runKeeper(deps, config.markets, {
      intervalMs: baseTick,
      signal: config.signal,
    });
  } finally {
    server?.close();
  }
}
