/// Reference order book mirrored from Binance spot depth. OpenPerps itself has
/// NO order book, trades match cross against the shared vault at the EWMA mark
///, so this depth is display-only and clearly labelled "Reference · Binance".
/// It gives traders a familiar market-depth view for the majors; it is NOT the
/// liquidity an OpenPerps order fills against.

import { useEffect, useMemo, useRef, useState } from "react";

type Level = [number, number]; // [price, size]
type Book = { bids: Level[]; asks: Level[] };

const WS_BASE = "wss://stream.binance.com:9443/ws";

function parseLevels(raw: [string, string][]): Level[] {
  return raw.map(([p, q]) => [Number(p), Number(q)] as Level).filter(([p, q]) => p > 0 && q > 0);
}

export function OrderBook({ symbol, base }: { symbol: string; base: string }) {
  const [book, setBook] = useState<Book | null>(null);
  const lastEmit = useRef(0);

  useEffect(() => {
    setBook(null);
    let ws: WebSocket | null = null;
    try {
      // Partial book depth stream: a full 20-level snapshot every 100ms, no
      // local diff bookkeeping needed.
      ws = new WebSocket(`${WS_BASE}/${symbol.toLowerCase()}@depth20@100ms`);
    } catch {
      return;
    }
    ws.onmessage = (e) => {
      const now = Date.now();
      if (now - lastEmit.current < 200) return; // ~5 fps
      lastEmit.current = now;
      try {
        const j = JSON.parse(e.data) as { bids?: [string, string][]; asks?: [string, string][] };
        if (!j.bids || !j.asks) return;
        setBook({ bids: parseLevels(j.bids), asks: parseLevels(j.asks) });
      } catch {
        /* ignore */
      }
    };
    return () => {
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const view = useMemo(() => {
    if (!book) return null;
    const asks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, 12);
    const bids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, 12);
    // Cumulative totals + max for the depth bars.
    let cum = 0;
    const askRows = asks.map(([p, s]) => ({ p, s, total: (cum += s) })).reverse(); // highest ask on top
    cum = 0;
    const bidRows = bids.map(([p, s]) => ({ p, s, total: (cum += s) }));
    const maxTotal = Math.max(askRows[0]?.total ?? 0, bidRows[bidRows.length - 1]?.total ?? 0, 1);
    const bestAsk = asks[0]?.[0] ?? 0;
    const bestBid = bids[0]?.[0] ?? 0;
    const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
    const spreadPct = mid ? (spread / mid) * 100 : 0;
    return { askRows, bidRows, maxTotal, mid, spreadPct };
  }, [book]);

  const fmtP = (p: number) =>
    p < 1
      ? p.toFixed(6)
      : p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtS = (s: number) =>
    s >= 1000
      ? `${(s / 1000).toFixed(2)}K`
      : s.toLocaleString(undefined, { maximumFractionDigits: 4 });

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.06em] text-muted-foreground px-1">
        <span>Order book</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wide text-muted-foreground px-1 pt-1">
        <span>Price</span>
        <span className="text-right">Size ({base})</span>
        <span className="text-right">Total</span>
      </div>

      {!view ? (
        <div className="py-6 text-center text-[11px] text-muted-foreground">
          Connecting to depth…
        </div>
      ) : (
        <>
          {view.askRows.map((r, i) => (
            <Row key={`a${i}`} side="ask" {...r} max={view.maxTotal} fmtP={fmtP} fmtS={fmtS} />
          ))}
          <div className="flex items-center justify-between px-1 py-1.5 my-0.5 border-y border-border/60">
            <span className="font-mono text-sm text-foreground num">{fmtP(view.mid)}</span>
            <span className="text-[10px] text-muted-foreground">
              Spread {view.spreadPct.toFixed(3)}%
            </span>
          </div>
          {view.bidRows.map((r, i) => (
            <Row key={`b${i}`} side="bid" {...r} max={view.maxTotal} fmtP={fmtP} fmtS={fmtS} />
          ))}
        </>
      )}
    </div>
  );
}

function Row({
  side,
  p,
  s,
  total,
  max,
  fmtP,
  fmtS,
}: {
  side: "ask" | "bid";
  p: number;
  s: number;
  total: number;
  max: number;
  fmtP: (n: number) => string;
  fmtS: (n: number) => string;
}) {
  const pct = Math.min(100, (total / max) * 100);
  const isAsk = side === "ask";
  return (
    <div className="relative grid grid-cols-3 gap-2 px-1 py-[3px] text-[11px] font-mono tabular-nums">
      <div
        className="absolute inset-y-0 right-0 rounded-[2px]"
        style={{
          width: `${pct}%`,
          background: isAsk ? "rgba(255,93,108,0.12)" : "rgba(61,220,132,0.12)",
        }}
      />
      <span className={`relative ${isAsk ? "text-danger" : "text-success"}`}>{fmtP(p)}</span>
      <span className="relative text-right text-foreground">{fmtS(s)}</span>
      <span className="relative text-right text-muted-foreground">{fmtS(total)}</span>
    </div>
  );
}
