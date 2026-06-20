#!/usr/bin/env node
/// CLI entrypoint for the OpenPerps relayer daemon. Loads the keeper keypair and
/// the markets file from the environment, then runs the crank loop with a live
/// price source and a `/health` endpoint until SIGINT/SIGTERM.
///
/// Environment:
///   OPENPERPS_RPC              RPC url (required)
///   OPENPERPS_KEEPER_KEYPAIR   path to the oracle-authority keypair json (required)
///   OPENPERPS_MARKETS          path to a market-config json or json array (required)
///   OPENPERPS_INTERVAL_MS      crank interval, default 60000
///   OPENPERPS_HEALTH_PORT      health server port, default 18810
///   OPENPERPS_HEALTH_HOST      health server bind host, default 0.0.0.0

import { readFileSync } from "node:fs";

import { Connection, Keypair } from "@solana/web3.js";
import { validateMarketConfig, type OpenPerpsMarketConfig } from "@opp-oss/sdk";

import { keeperMarketFromConfig, parseRelayerEnv, runRelayer } from "../daemon.ts";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadMarkets(path: string): OpenPerpsMarketConfig[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(validateMarketConfig);
}

async function main(): Promise<void> {
  const env = parseRelayerEnv(process.env);
  const connection = new Connection(env.rpc, "confirmed");
  const authority = loadKeypair(env.keypairPath);
  const markets = loadMarkets(env.marketsPath).map((config) => keeperMarketFromConfig(config));

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(`[relayer] ${sig} received, shutting down`);
      controller.abort();
    });
  }

  console.error(
    `[relayer] starting: ${markets.length} market(s), rpc ${env.rpc}, authority ${authority.publicKey.toBase58()}`,
  );
  await runRelayer({
    connection,
    authority,
    markets,
    intervalMs: env.intervalMs,
    healthServer: { port: env.healthPort, host: env.healthHost },
    signal: controller.signal,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
