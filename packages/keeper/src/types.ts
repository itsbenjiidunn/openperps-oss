import type { Connection, Keypair } from "@solana/web3.js";
import type { OpenPerpsMarketConfig, PriceProvider } from "@openperps/sdk";
import type { KeeperHealth } from "./health.ts";

export type KeeperMarket = {
  config: OpenPerpsMarketConfig;
  /// The market's on-chain `max_accrual_dt_slots` (the freshness window the
  /// keeper must respect when bursting catch-up accruals).
  maxAccrualDtSlots: number;
  /// The market's on-chain `max_price_move_bps_per_slot`. Caps how far each
  /// catch-up accrual may advance the price, so a large jump is split into steps
  /// that each clear the engine's per-slot move bound.
  maxPriceMoveBpsPerSlot: number;
  /// When true, the keeper passes the market's `[ORACLE_SEED, market]` oracle
  /// authority PDA to `AccrueAsset`, so a market that set a custom oracle
  /// authority (via `SetOracleAuthority`) is priced by `deps.authority`. Omit
  /// (or false) for markets that stay on the relayer constant.
  useOracleAuthorityPda?: boolean;
  /// Desired crank cadence in ms: the relayer pushes this market at most once per
  /// `pushIntervalMs`. A fast-moving (Volatile / memecoin) market wants a short
  /// cadence so its mark tracks the live price and leaves little stale-mark gap
  /// for latency arbitrage; a Stable market can push slowly and cheaply. When
  /// omitted, the runner cranks the market every loop tick.
  pushIntervalMs?: number;
};

export type KeeperLogLevel = "info" | "error";

export type KeeperDeps = {
  connection: Connection;
  /// The oracle authority keypair. It must match each market's pinned oracle
  /// authority, or `AccrueAsset` is rejected by the program.
  authority: Keypair;
  priceProvider: PriceProvider;
  /// Optional mutable health/metrics record (from `createKeeperHealth`). When
  /// provided, the runner records per-market crank / stale / error state and
  /// totals; read it live to serve a `/health` endpoint.
  health?: KeeperHealth;
  log?: (level: KeeperLogLevel, message: string, extra?: unknown) => void;
};
