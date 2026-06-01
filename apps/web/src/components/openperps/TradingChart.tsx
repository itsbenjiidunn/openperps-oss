/// User-facing perp trading chart (V1). Real candles from Pyth, the live mark
/// folded into the forming bar, plus position overlays: mark / entry / liq
/// lines, buy-sell execution markers, and a live unrealized-PnL badge. Built
/// on TradingView Lightweight Charts so we own the data (oracle marks, on-chain
/// fills) rather than embedding TradingView's market data.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import {
  INTERVALS,
  bucketStart,
  loadHistory,
  pythSymbolFor,
  type Bar,
  type Interval,
} from "@/lib/chartData";
import type { Market } from "@/lib/types";

const BULL = "#16f2b3";
const BEAR = "#ff4d57";
const GRID = "rgba(35, 255, 190, 0.06)";
const AXIS = "rgba(35, 255, 190, 0.10)";
const MUTED = "#5b716d";

/// The user's open position on this market, for the entry/liq overlays + PnL.
export type ChartOverlay = {
  side: number; // 0 long, 1 short
  entry: number; // USD
  size: number; // base units
  liq?: number; // USD (estimate)
} | null;

/// A fill to mark on the chart.
export type ChartMarker = { ts: number; side: number; price: number };

function fmtUsd(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return p < 1 ? p.toFixed(6) : p.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function TradingChart({
  market,
  overlay,
  markers,
  livePrice,
  className,
}: {
  market: Market;
  overlay?: ChartOverlay;
  markers?: ChartMarker[];
  /// Continuous display price (Pyth Hermes stream). Drives the forming candle,
  /// mark line and PnL so they tick like a real DEX. Falls back to the
  /// on-chain mark when absent.
  livePrice?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastBarRef = useRef<Bar | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markLineRef = useRef<IPriceLine | null>(null);

  const [interval, setInterval] = useState<Interval>("15m");
  const [loading, setLoading] = useState(true);
  const [hasHistory, setHasHistory] = useState(true);
  const [liveClose, setLiveClose] = useState<number>(market.price);

  const hasPyth = useMemo(() => pythSymbolFor(market) !== null, [market]);

  // The display mark: the live Hermes tick when available, else the on-chain
  // mark. This is what makes the candle / mark line move continuously.
  const mark = livePrice && livePrice > 0 ? livePrice : market.price;

  // ---- create the chart once ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: MUTED,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: AXIS },
      timeScale: { borderColor: AXIS, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candle = chart.addCandlestickSeries({
      upColor: BULL,
      downColor: BEAR,
      wickUpColor: BULL,
      wickDownColor: BEAR,
      borderVisible: false,
      priceFormat: {
        type: "price",
        precision: market.price < 1 ? 6 : 2,
        minMove: market.price < 1 ? 0.000001 : 0.01,
      },
    });
    const vol = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: "rgba(124, 109, 255, 0.35)",
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      lastBarRef.current = null;
      priceLinesRef.current = [];
      markLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- load history when market or interval changes ----
  useEffect(() => {
    let cancelled = false;
    const candle = candleRef.current;
    const vol = volRef.current;
    if (!candle || !vol) return;
    setLoading(true);
    void loadHistory(market, interval).then((bars) => {
      if (cancelled) return;
      if (bars.length > 0) {
        candle.setData(
          bars.map((b) => ({
            time: b.time as UTCTimestamp,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          })),
        );
        vol.setData(
          bars.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? "rgba(22,242,179,0.30)" : "rgba(255,77,87,0.30)",
          })),
        );
        lastBarRef.current = bars[bars.length - 1]!;
        setHasHistory(true);
      } else {
        // No Pyth history (custom SPL): seed one bar at the live mark and let
        // live updates build the series forward.
        const t = bucketStart(Math.floor(Date.now() / 1000), interval);
        const p = market.price || 0;
        const seed: Bar = { time: t, open: p, high: p, low: p, close: p, volume: 0 };
        candle.setData(
          p > 0
            ? [{ time: t as UTCTimestamp, open: p, high: p, low: p, close: p }]
            : [],
        );
        vol.setData([]);
        lastBarRef.current = p > 0 ? seed : null;
        setHasHistory(false);
      }
      chartRef.current?.timeScale().fitContent();
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.assetIndex, market.symbol, interval]);

  // ---- fold the live mark into the forming candle ----
  useEffect(() => {
    const candle = candleRef.current;
    const price = mark;
    if (!candle || !price || price <= 0) return;
    setLiveClose(price);
    const nowBucket = bucketStart(Math.floor(Date.now() / 1000), interval);
    const last = lastBarRef.current;
    let bar: Bar;
    if (!last || nowBucket > last.time) {
      bar = {
        time: nowBucket,
        open: last?.close ?? price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      };
    } else if (nowBucket === last.time) {
      bar = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
      };
    } else {
      return; // stale tick older than the last bar
    }
    lastBarRef.current = bar;
    const point: CandlestickData = {
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    };
    candle.update(point);
  }, [mark, interval]);

  // ---- mark price line: update in place each tick (don't recreate) ----
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle || !mark || mark <= 0) return;
    if (markLineRef.current) {
      markLineRef.current.applyOptions({ price: mark });
    } else {
      markLineRef.current = candle.createPriceLine({
        price: mark,
        color: "#ffb454",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Mark",
      });
    }
  }, [mark]);

  // ---- entry / liq overlay lines (recreated only when the position changes) ----
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    for (const l of priceLinesRef.current) candle.removePriceLine(l);
    priceLinesRef.current = [];
    const add = (price: number | undefined, color: string, title: string, dashed: boolean) => {
      if (!price || price <= 0 || !Number.isFinite(price)) return;
      priceLinesRef.current.push(
        candle.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title,
        }),
      );
    };
    if (overlay) {
      add(overlay.entry, "#3bd6ff", "Entry", false);
      add(overlay.liq, BEAR, "Liq (est)", true);
    }
  }, [overlay]);

  // ---- buy/sell execution markers ----
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    const ms: SeriesMarker<Time>[] = (markers ?? [])
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .map((m) => {
        const long = m.side === 0;
        return {
          time: bucketStart(Math.floor(m.ts / 1000), interval) as UTCTimestamp,
          position: long ? "belowBar" : "aboveBar",
          color: long ? BULL : BEAR,
          shape: long ? "arrowUp" : "arrowDown",
          text: long ? "B" : "S",
        } as SeriesMarker<Time>;
      });
    candle.setMarkers(ms);
  }, [markers, interval]);

  // ---- live unrealized PnL (entry vs current mark) ----
  const pnl = useMemo(() => {
    if (!overlay || !overlay.entry || overlay.size <= 0) return null;
    const dir = overlay.side === 0 ? 1 : -1;
    const usd = (liveClose - overlay.entry) * overlay.size * dir;
    const pct = ((liveClose - overlay.entry) / overlay.entry) * 100 * dir;
    return { usd, pct };
  }, [overlay, liveClose]);

  return (
    <div className={`relative ${className ?? ""}`}>
      {/* interval selector */}
      <div className="absolute z-10 top-2 left-2 flex gap-1 text-[11px]">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval(iv)}
            className={`px-2 py-0.5 rounded ${
              interval === iv
                ? "text-neon bg-[oklch(0.86_0.16_188_/_0.12)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {iv}
          </button>
        ))}
      </div>

      {/* live PnL badge */}
      {pnl && (
        <div className="absolute z-10 top-2 right-2 panel-flat rounded-md px-2.5 py-1.5 text-[11px] font-mono">
          <span className="text-muted-foreground mr-1.5">uPnL</span>
          <span className={pnl.usd >= 0 ? "text-success" : "text-danger"}>
            {pnl.usd >= 0 ? "+" : ""}
            {pnl.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
          </span>
          <span className={`ml-1.5 ${pnl.pct >= 0 ? "text-success" : "text-danger"}`}>
            ({pnl.pct >= 0 ? "+" : ""}
            {pnl.pct.toFixed(2)}%)
          </span>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />

      {/* states */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground pointer-events-none">
          Loading {market.symbol} candles…
        </div>
      )}
      {!loading && !hasHistory && (
        <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground">
          {hasPyth
            ? "No history returned — building from live mark."
            : "Custom market · building candles from the live on-chain mark."}
        </div>
      )}
    </div>
  );
}
