/// Candle data for the trading chart. Real OHLC comes from Pyth's public
/// benchmarks TradingView shim (the same price source the on-chain relayer
/// pushes as the mark), so the chart and the mark track the same market.
/// Live updates fold the current mark into the forming candle. Markets with
/// no Pyth symbol (custom devnet SPL) get no history — the chart builds bars
/// forward from the live mark instead of showing fabricated candles.

import { candlesUrl } from "./indexer";

export type Interval = "1m" | "5m" | "15m" | "1h";
export const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h"];

/// TradingView resolution string per interval.
const RESOLUTION: Record<Interval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
};

export const intervalSeconds: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

const BENCHMARKS = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

export type Bar = {
  /// Bar open time, unix seconds (lightweight-charts UTCTimestamp).
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/// The Pyth crypto benchmark symbol for a market, e.g. "Crypto.BTC/USD".
/// Returns null when the asset has no Pyth feed (custom devnet SPL), in which
/// case the chart falls back to building bars from the live mark.
export function pythSymbolFor(market: { base: string; oracleKind?: string }): string | null {
  const b = market.base?.trim().toUpperCase();
  if (!b) return null;
  // Any Pyth-backed market maps to its crypto benchmark feed. The official
  // majors (SOL/BTC/ETH/JUP) are all "pyth"; custom SPL markets are not.
  if (market.oracleKind === "pyth") return `Crypto.${b}/USD`;
  return null;
}

/// ~300 bars of history for the given interval.
export function historyWindowSec(interval: Interval): number {
  return intervalSeconds[interval] * 300;
}

/// Start-of-candle bucket (unix seconds) for a timestamp.
export function bucketStart(tsSec: number, interval: Interval): number {
  const s = intervalSeconds[interval];
  return Math.floor(tsSec / s) * s;
}

/// Fetch real OHLC bars from Pyth benchmarks. Empty array on any failure (the
/// chart then builds forward from the live mark).
export async function fetchPythHistory(
  symbol: string,
  interval: Interval,
  fromSec: number,
  toSec: number,
): Promise<Bar[]> {
  try {
    const url =
      `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}` +
      `&resolution=${RESOLUTION[interval]}&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = (await res.json()) as {
      s: string;
      t?: number[];
      o?: number[];
      h?: number[];
      l?: number[];
      c?: number[];
      v?: number[];
    };
    if (j.s !== "ok" || !j.t?.length) return [];
    const bars: Bar[] = [];
    for (let i = 0; i < j.t.length; i++) {
      const o = j.o?.[i];
      const h = j.h?.[i];
      const l = j.l?.[i];
      const c = j.c?.[i];
      if (o === undefined || h === undefined || l === undefined || c === undefined) continue;
      bars.push({ time: j.t[i]!, open: o, high: h, low: l, close: c, volume: j.v?.[i] ?? 0 });
    }
    return bars;
  } catch {
    return [];
  }
}

/// The asset's price ~24h ago, for a real 24h-change figure (combined with the
/// live mark). Pyth for majors, GeckoTerminal for custom mainnet tokens. Null
/// when neither has data.
export async function fetch24hAgoPrice(market: {
  base: string;
  oracleKind?: string;
  baseMint?: string;
}): Promise<number | null> {
  const symbol = pythSymbolFor(market);
  if (symbol) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 86_400 - 3_600; // 25h window so the first bar is ~24h ago
    const bars = await fetchPythHistory(symbol, "1h", from, to);
    return bars.length ? bars[0]!.open : null;
  }
  if (market.baseMint) {
    const bars = await fetchGeckoHistory(market.baseMint, "1h");
    if (!bars.length) return null;
    // First bar whose time is ~24h old (GeckoTerminal hourly, ascending).
    const cutoff = Math.floor(Date.now() / 1000) - 86_400;
    const bar = bars.find((b) => b.time >= cutoff) ?? bars[0]!;
    return bar.open;
  }
  return null;
}

// ---------- mainnet token data (custom markets) ----------
//
// A launched market lists a real mainnet SPL by mint, so its chart + price come
// from MAINNET data even though trading settles on devnet — you trade a real
// token's price action against the devnet House. Majors keep using Pyth; custom
// markets (a baseMint, not Pyth) read GeckoTerminal (free, CORS-ok) for OHLC and
// Jupiter for the live price.

const histCache = new Map<string, { bars: Bar[]; ts: number }>();

/// Real OHLC for a mainnet SPL by mint, from the indexer's cached `/candles`
/// (DEX-pool history seeded from GeckoTerminal server-side + stored in D1, so it
/// scales to many users without 429ing). Cached ~20s client-side so the chart,
/// 24h ref and re-mounts share one request. Empty on failure.
export async function fetchGeckoHistory(mint: string, interval: Interval): Promise<Bar[]> {
  const key = `${mint}:${interval}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.ts < 20_000) return hit.bars;
  try {
    const res = await fetch(candlesUrl(mint, interval));
    if (!res.ok) return hit?.bars ?? [];
    const j = (await res.json()) as { ohlcv_list?: number[][] };
    const list = j.ohlcv_list ?? [];
    const bars = list
      .map((r) => ({
        time: r[0]!,
        open: r[1]!,
        high: r[2]!,
        low: r[3]!,
        close: r[4]!,
        volume: r[5] ?? 0,
      }))
      .filter((b) => Number.isFinite(b.close) && b.close > 0)
      .sort((a, b) => a.time - b.time);
    if (bars.length) histCache.set(key, { bars, ts: Date.now() });
    return bars;
  } catch {
    return hit?.bars ?? [];
  }
}

/// Load the candle history for a market+interval. Pyth for majors, GeckoTerminal
/// (by mint) for custom mainnet tokens. Returns [] only when neither resolves —
/// the caller then seeds bars from the live mark.
export async function loadHistory(
  market: { base: string; oracleKind?: string; baseMint?: string },
  interval: Interval,
): Promise<Bar[]> {
  const symbol = pythSymbolFor(market);
  if (symbol) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - historyWindowSec(interval);
    return fetchPythHistory(symbol, interval, from, to);
  }
  if (market.baseMint) return fetchGeckoHistory(market.baseMint, interval);
  return [];
}
