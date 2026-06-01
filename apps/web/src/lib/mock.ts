/// Compatibility shim for routes/components still importing from `@/lib/mock`.
///
/// As Phase 2 of the frontend integration:
///   - format helpers and type definitions moved to dedicated modules
///     (`format.ts`, `types.ts`) and are re-exported here for back-compat.
///   - activity feeds (`recentTrades`, `fundingEvents`, `liquidations`,
///     `crankQueue`) are now empty arrays — honest no-indexer state until
///     Phase 6 wires real RPC log scraping or a dedicated indexer.
///   - `markets` is exported empty by default; the Terminal route now sources
///     its data from `useMarkets()` (see `onchain.ts`). Anything still
///     importing `markets` will simply render an empty list, which the
///     individual route's Phase 3+ refactor will replace with a real hook.
///   - `account` / `positions` / `vault` are kept as placeholder fixtures
///     until Phases 4–5 land per-route live data hooks.

export { fmtNum, fmtPct, fmtPubkey, fmtUsd } from "./format";
export type {
  AccountSummary,
  CrankQueueRow,
  FundingEvent,
  LiquidationRow,
  Market,
  OracleSource,
  OracleStatus,
  Position,
  TradeRow,
  VaultSummary,
} from "./types";

import type {
  AccountSummary,
  CrankQueueRow,
  FundingEvent,
  LiquidationRow,
  Market,
  Position,
  TradeRow,
  VaultSummary,
} from "./types";

/// Empty until the Terminal route migrates to `useMarkets()`. Routes that
/// have already migrated read from the hook directly.
export const markets: Market[] = [];

/// Empty until Phase 6 wires either an indexer or a small RPC log scraper.
export const recentTrades: TradeRow[] = [];
export const fundingEvents: FundingEvent[] = [];
export const liquidations: LiquidationRow[] = [];
export const crankQueue: CrankQueueRow[] = [];

/// Placeholder portfolio summary until Phase 4 lands `usePortfolioState`.
export const positions: Position[] = [];

/// Placeholder account / vault summaries until per-route hooks land.
/// Values are zeroed so number-format helpers render cleanly.
export const account: AccountSummary = {
  address: "",
  collateral: 0,
  withdrawable: 0,
  marginRatio: 0,
  health: 0,
  unrealized: 0,
  realized: 0,
};

export const vault: VaultSummary = {
  tvl: 0,
  utilization: 0,
  reserves: 0,
  insurance: 0,
  apr: 0,
  protocolFees: 0,
};
