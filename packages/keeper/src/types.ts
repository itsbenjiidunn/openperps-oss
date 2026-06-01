import type { Connection, Keypair } from "@solana/web3.js";
import type { OpenPerpsMarketConfig, PriceProvider } from "@openperps/sdk";

export type KeeperMarket = {
  config: OpenPerpsMarketConfig;
  /// The market's on-chain `max_accrual_dt_slots` (the freshness window the
  /// keeper must respect when bursting catch-up accruals).
  maxAccrualDtSlots: number;
  /// The market's on-chain `max_price_move_bps_per_slot`. Caps how far each
  /// catch-up accrual may advance the price, so a large jump is split into steps
  /// that each clear the engine's per-slot move bound.
  maxPriceMoveBpsPerSlot: number;
};

export type KeeperLogLevel = "info" | "error";

export type KeeperDeps = {
  connection: Connection;
  /// The oracle authority keypair. It must match each market's pinned oracle
  /// authority, or `AccrueAsset` is rejected by the program.
  authority: Keypair;
  priceProvider: PriceProvider;
  log?: (level: KeeperLogLevel, message: string, extra?: unknown) => void;
};
