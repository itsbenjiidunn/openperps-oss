/// Keeper health + metrics for self-host monitoring. The runner maintains a
/// mutable `KeeperHealth` (pass it on `KeeperDeps.health`); the integrator reads
/// it live and serves it from their own `/health` endpoint. The pure helpers
/// here (`marketBehind`, `isMarketStale`, `summarizeHealth`) are deterministic
/// and unit-tested.

export type KeeperMarketHealth = {
  marketId: string;
  /// Epoch ms of the last successful crank.
  lastCrankMs?: number;
  /// The asset's `slot_last` at the last crank.
  lastSlotLast?: number;
  /// How many slots behind the chain the asset was at the last crank.
  behindSlots?: number;
  /// True when the asset is behind by more than its freshness window: the keeper
  /// is not keeping it current and the engine may stale-lock risk-increasing
  /// trades until it catches up.
  stale: boolean;
  lastSignature?: string;
  lastError?: string;
  /// Consecutive crank failures; resets to 0 on a success.
  consecutiveFailures: number;
};

export type KeeperHealth = {
  startedMs: number;
  markets: Record<string, KeeperMarketHealth>;
  totals: {
    cranks: number;
    crankFailures: number;
    accruals: number;
    liquidations: number;
  };
};

/// A fresh, empty health record. Create one, pass it on `KeeperDeps.health`, and
/// read it live (e.g. serve `summarizeHealth(health)` from an HTTP endpoint).
export function createKeeperHealth(): KeeperHealth {
  return {
    startedMs: Date.now(),
    markets: {},
    totals: { cranks: 0, crankFailures: 0, accruals: 0, liquidations: 0 },
  };
}

/// Slots an asset is behind the chain (never negative).
export function marketBehind(slotLast: number, nowSlot: number): number {
  return Math.max(0, nowSlot - slotLast);
}

/// True when an asset is behind by more than its freshness window
/// (`max_accrual_dt_slots`), i.e. the keeper is falling behind.
export function isMarketStale(behindSlots: number, maxAccrualDtSlots: number): boolean {
  return behindSlots > maxAccrualDtSlots;
}

/// One-glance health for a `/health` endpoint: healthy when no market is stale
/// and none has a run of failures.
export function summarizeHealth(health: KeeperHealth): {
  healthy: boolean;
  staleMarkets: string[];
  failingMarkets: string[];
} {
  const staleMarkets: string[] = [];
  const failingMarkets: string[] = [];
  for (const m of Object.values(health.markets)) {
    if (m.stale) staleMarkets.push(m.marketId);
    if (m.consecutiveFailures >= 3) failingMarkets.push(m.marketId);
  }
  return {
    healthy: staleMarkets.length === 0 && failingMarkets.length === 0,
    staleMarkets,
    failingMarkets,
  };
}

function ensureMarket(health: KeeperHealth, marketId: string): KeeperMarketHealth {
  const existing = health.markets[marketId];
  if (existing) return existing;
  const fresh: KeeperMarketHealth = { marketId, stale: false, consecutiveFailures: 0 };
  health.markets[marketId] = fresh;
  return fresh;
}

/// Record a successful crank for a market (clears the error + failure streak).
export function recordCrankOk(
  health: KeeperHealth,
  marketId: string,
  info: {
    slotLast: number;
    behindSlots: number;
    stale: boolean;
    signature: string;
    accruals: number;
  },
): void {
  const m = ensureMarket(health, marketId);
  m.lastCrankMs = Date.now();
  m.lastSlotLast = info.slotLast;
  m.behindSlots = info.behindSlots;
  m.stale = info.stale;
  m.lastSignature = info.signature;
  m.lastError = undefined;
  m.consecutiveFailures = 0;
  health.totals.cranks += 1;
  health.totals.accruals += info.accruals;
}

/// Record a failed crank for a market (increments its failure streak).
export function recordCrankError(health: KeeperHealth, marketId: string, error: unknown): void {
  const m = ensureMarket(health, marketId);
  m.lastError = error instanceof Error ? error.message : String(error);
  m.consecutiveFailures += 1;
  health.totals.crankFailures += 1;
}

/// Record landed liquidations against the totals.
export function recordLiquidations(health: KeeperHealth, count: number): void {
  health.totals.liquidations += count;
}
