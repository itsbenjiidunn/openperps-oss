import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Rocket, ChevronLeft, ChevronDown, Star, Search } from "lucide-react";

import { MarketBrowser } from "@/components/openperps/MarketBrowser";
import {
  TradingChart,
  type ChartMarker,
  type ChartOverlay,
} from "@/components/openperps/TradingChart";
import { OrderPanel } from "@/components/openperps/OrderPanel";
import { AccountPanel } from "@/components/openperps/AccountPanel";
import { OrderBook } from "@/components/openperps/OrderBook";
import { AccountTabs } from "@/components/openperps/AccountTabs";
import { useQuery } from "@tanstack/react-query";
import { fmtPct, fmtUsd, fmtPubkey } from "@/lib/format";
import { useMarkets, usePortfolioPositions, usePortfolioState } from "@/lib/onchain";
import { useLivePrice, useLivePrices, useMarketMark, normalizeFeedId } from "@/lib/livePrice";
import { useMainnetLiquidity } from "@/lib/mainnetPrice";
import { userPortfolio } from "@/lib/program";
import { useTrades, localVwapEntry } from "@/lib/tradeLog";
import { fetchGlobalTrades, fetchPositionEntries, fetchStats, entryKey } from "@/lib/indexer";
import { SHARED_MARKET } from "@/lib/sharedMarket";
import { fetch24hAgoPrice } from "@/lib/chartData";
import { useDexStatsMany } from "@/lib/dexscreener";
import { marketKey, type Market } from "@/lib/types";

type TerminalSearch = { market?: string };

export const Route = createFileRoute("/app")({
  // Selected market is the composite `pubkey:assetIndex` key (see marketKey).
  // assetIndex alone is NOT unique, every custom own-group launch is slot 0,
  // which collided with the slot-0 major (SOL) and redirected there. Persisting
  // the composite key in the URL makes refresh/share work for both tiers.
  validateSearch: (search: Record<string, unknown>): TerminalSearch => {
    const raw = search.market;
    return typeof raw === "string" && raw.length > 0 ? { market: raw } : {};
  },
  head: () => ({
    meta: [
      { title: "Trading Terminal: OpenPerps" },
      {
        name: "description",
        content: "Trade permissionless Solana perpetuals with cross-margin USDC collateral.",
      },
    ],
  }),
  component: Terminal,
});

function Terminal() {
  const marketsQ = useMarkets();
  const markets = marketsQ.data ?? [];
  const { market: selectedKey } = Route.useSearch();
  const navigate = useNavigate({ from: "/app" });

  const select = (key: string) => navigate({ search: { market: key } });
  const clear = () => navigate({ search: {} });

  if (marketsQ.isLoading) {
    return <CenterMessage title="Loading markets…" />;
  }
  if (markets.length === 0) {
    return <NoMarketsState />;
  }

  const m =
    selectedKey !== undefined ? markets.find((x) => marketKey(x) === selectedKey) : undefined;

  // Default Terminal state: market discovery. No chart/trade until a market is
  // picked (or the URL points at one that no longer exists → back to browser).
  if (!m) {
    return <MarketBrowser markets={markets} onSelect={select} />;
  }

  return (
    <div className="px-3 py-3 lg:px-4">
      <button
        onClick={clear}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Markets
      </button>
      {/* Market selector + live metrics (full-width header) */}
      <MarketHeader market={m} markets={markets} onSelect={select} />

      <div className="mt-3 grid gap-3 grid-cols-1 lg:grid-cols-[1fr_300px_320px]">
        {/* Chart + your account */}
        <div className="space-y-3 min-w-0">
          <ChartPanel market={m} />

          <div className="grid grid-cols-1 lg:hidden gap-3">
            <RightRail market={m} />
            <OrderPanel market={m} />
            <AccountPanel market={m} />
          </div>

          <AccountTabs markets={markets} />
        </div>

        {/* Order book / market trades, beside the chart */}
        <div className="hidden lg:block">
          <RightRail market={m} />
        </div>

        {/* Order form + account summary */}
        <div className="hidden lg:flex flex-col gap-3">
          <OrderPanel market={m} />
          <AccountPanel market={m} />
        </div>
      </div>
    </div>
  );
}

function NoMarketsState() {
  return (
    <div className="px-4 py-12 flex flex-col items-center justify-center text-center">
      <div className="max-w-md panel p-8 space-y-4">
        <div className="mx-auto h-12 w-12 rounded-full bg-[oklch(0.86_0.16_188_/_0.10)] flex items-center justify-center">
          <Rocket className="h-6 w-6 text-neon" />
        </div>
        <h1 className="font-display text-2xl font-semibold">No markets in your registry yet</h1>
        <p className="text-sm text-muted-foreground">
          OpenPerps is permissionless, anyone can spin up a market against any SPL mint. Launch
          your first one to start trading. The registry lives in your browser until an on-chain
          registry account ships.
        </p>
        <Link
          to="/launch"
          className="btn-primary inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
        >
          <Rocket className="h-4 w-4" /> Launch a market
        </Link>
      </div>
    </div>
  );
}

function CenterMessage({ title }: { title: string }) {
  return (
    <div className="px-4 py-20 flex items-center justify-center">
      <div className="text-sm text-muted-foreground">{title}</div>
    </div>
  );
}

/// 24h-ago Pyth price per market, batched + cached, for real 24h-change figures
/// in the header and the market dropdown.
function use24hRefs(markets: Market[]) {
  const key = markets.map((m) => m.base).join(",");
  return useQuery({
    queryKey: ["refs24h", key],
    enabled: markets.length > 0,
    refetchInterval: 300_000,
    staleTime: 300_000,
    queryFn: async () => {
      const entries = await Promise.all(
        markets.map(async (m) => [m.assetIndex, await fetch24hAgoPrice(m)] as const),
      );
      return new Map(entries.filter((e): e is [number, number] => e[1] != null));
    },
  });
}

function MarketHeader({
  market: m,
  markets,
  onSelect,
}: {
  market: Market;
  markets: Market[];
  onSelect: (key: string) => void;
}) {
  // One Hermes stream for every listed market; the header mark + the dropdown
  // rows all read from it.
  const livePrices = useLivePrices(markets.map((x) => x.oracleFeedId));
  // 24h change + volume from DexScreener (keyed by token mint) for every market
  // with a real mint, majors and custom alike, so the header, the dropdown
  // rows and the chart all agree and the asset-slot-0 collision (custom groups
  // + SOL all on slot 0) can't smear them together. Synthetic markets fall back
  // to the Pyth 24h-ago ref + indexed volume.
  const dexQ = useDexStatsMany(markets.map((x) => x.baseMint).filter((x): x is string => !!x));
  const synthetic = markets.filter((x) => !x.baseMint);
  const refsQ = use24hRefs(synthetic);
  const statsQ = useQuery({
    queryKey: ["stats24h"],
    queryFn: () => fetchStats(),
    refetchInterval: 30_000,
  });

  const priceOf = (x: Market) =>
    (x.oracleFeedId && livePrices.get(normalizeFeedId(x.oracleFeedId))) || x.price;
  const changeOf = (x: Market): number | null => {
    if (x.baseMint) {
      const d = dexQ.data?.get(x.baseMint);
      return d ? d.change24h : null;
    }
    const ref = refsQ.data?.get(x.assetIndex);
    const px = priceOf(x);
    return ref && ref > 0 && px > 0 ? ((px - ref) / ref) * 100 : null;
  };
  const volOf = (x: Market) => {
    if (x.baseMint) return dexQ.data?.get(x.baseMint)?.volume24h ?? 0;
    return statsQ.data?.[x.assetIndex]?.volume ?? 0;
  };

  const [open, setOpen] = useState(false);
  // Mark = the live price the UI ticks at (Pyth for majors, live DEX spot for
  // custom). The on-chain engine price (shown secondary as "Engine") is what
  // PnL / liquidation settle at; the relayer keeps the two within ~1%.
  const mark = useMarketMark(m);
  // 24h change / volume now come from DexScreener for any real-mint market (see
  // above); liquidity is shown for custom markets only.
  const isCustom = !!(m.ownGroup && m.baseMint);
  const change = changeOf(m);
  const vol = volOf(m);
  // Liquidity: aggregator first (DexScreener/Gecko), but fall back to the live
  // on-chain pool reserves (via the shared price-feed DO, same socket as the
  // mark) so a just-launched market shows liquidity instantly instead of "-".
  const onchainLiq = useMainnetLiquidity(isCustom ? m.baseMint : undefined);
  const liq = (m.baseMint ? (dexQ.data?.get(m.baseMint)?.liquidityUsd ?? 0) : 0) || onchainLiq;
  const fmtMark = (p: number) =>
    p <= 0
      ? "-"
      : p < 1
        ? p.toFixed(6)
        : p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="panel relative px-3 py-2.5 flex flex-wrap items-center gap-x-7 gap-y-2">
      {/* market name → dropdown trigger */}
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2.5 text-left -m-1 p-1 rounded hover:bg-panel-2/60"
        >
          <span className="h-7 w-7 shrink-0 rounded-full grid place-items-center text-[11px] font-bold text-neon-foreground bg-gradient-to-br from-neon to-[var(--neon-dim)]">
            {m.base.slice(0, 1)}
          </span>
          <div>
            <div className="text-[11px] text-muted-foreground">Market</div>
            <div className="font-display text-lg font-semibold tracking-tight flex items-center gap-1.5">
              {m.symbol}
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            </div>
          </div>
        </button>
        {/* dropdown drops straight down under the Market button */}
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <MarketDropdown
              markets={markets}
              current={m}
              onSelect={(i) => {
                onSelect(i);
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
              priceOf={priceOf}
              changeOf={changeOf}
              volOf={volOf}
            />
          </>
        )}
      </div>

      <div>
        <div className="text-[11px] text-muted-foreground">Mark</div>
        <div className="font-mono text-lg text-neon num">{fmtMark(mark)}</div>
        <div className="text-[10px] text-muted-foreground">
          {isCustom ? "live · DEX" : `Pyth · ${m.oracleStatus}`}
        </div>
      </div>
      {isCustom ? (
        // The on-chain engine price PnL / liquidation actually settle at. The
        // relayer converges it toward the live Mark (above) within ~1%; it steps
        // every ~1–2 min, so it's shown secondary while Mark ticks live.
        <Cell k="Engine" v={m.price > 0 ? fmtMark(m.price) : "-"} sub="on-chain · PnL/liq" />
      ) : (
        <Cell k="Oracle" v={fmtMark(m.price)} sub={`Pyth · ${m.oracleStatus}`} />
      )}
      <Cell
        k="24h change"
        v={change === null ? "-" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
        cls={change === null ? "" : change >= 0 ? "text-success" : "text-danger"}
      />
      <Cell k="24h volume" v={vol > 0 ? fmtUsd(vol) : "-"} />
      {isCustom && <Cell k="Liquidity" v={liq > 0 ? fmtUsd(liq) : "-"} />}
      <Cell k="Open interest" v={m.openInterest > 0 ? fmtUsd(m.openInterest) : "-"} />
      <Cell
        k="Funding 1h"
        v={fmtPct(m.funding, 4)}
        cls={m.funding >= 0 ? "text-success" : "text-danger"}
      />
    </div>
  );
}

/// The market name as a dropdown button → a "Choose Market" panel (search +
/// live price / 24h change / volume per market), like a CEX/Hyperliquid picker.
type SortKey = "price" | "change" | "volume" | "funding";

function MarketDropdown({
  markets,
  current,
  onSelect,
  onClose,
  priceOf,
  changeOf,
  volOf,
}: {
  markets: Market[];
  current: Market;
  onSelect: (key: string) => void;
  onClose: () => void;
  priceOf: (m: Market) => number;
  changeOf: (m: Market) => number | null;
  volOf: (m: Market) => number;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<"all" | "perps" | "custom" | "fav">("all");
  const [favs, setFavs] = useState<Set<string>>(() => loadFavs());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "volume", dir: -1 });
  const [shown, setShown] = useState(false);

  // fade + slide-in on open
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const annFunding = (m: Market) => m.funding * 24 * 365 * 100;
  const isFav = (m: Market) => favs.has(m.base);
  const toggleFav = (base: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavs((prev) => {
      const n = new Set(prev);
      if (n.has(base)) n.delete(base);
      else n.add(base);
      saveFavs(n);
      return n;
    });
  };

  const cats: [typeof cat, string][] = [
    ["all", "All"],
    ["perps", "Perps"],
    ["custom", "Custom"],
    ["fav", "Favorites"],
  ];
  const metric = (m: Market, k: SortKey) =>
    k === "price"
      ? priceOf(m)
      : k === "change"
        ? (changeOf(m) ?? -Infinity)
        : k === "funding"
          ? annFunding(m)
          : volOf(m);
  const list = markets
    .filter((m) =>
      cat === "all"
        ? true
        : cat === "perps"
          ? !!m.cexSymbol
          : cat === "custom"
            ? !m.cexSymbol
            : isFav(m),
    )
    .filter(
      (m) =>
        m.symbol.toLowerCase().includes(q.toLowerCase()) ||
        m.base.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => (metric(a, sort.key) - metric(b, sort.key)) * sort.dir);

  const fmtP = (p: number) =>
    p <= 0 ? "-" : p < 1 ? p.toFixed(6) : p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");

  // Responsive: phone shows star/market/price; +24h at sm; +volume/APR at md,
  // so the dense columns never collide on a narrow screen.
  const COLS =
    "grid-cols-[18px_1.4fr_1fr] sm:grid-cols-[18px_1.6fr_1fr_0.9fr] md:grid-cols-[18px_1.6fr_1fr_0.8fr_1fr_0.9fr]";

  return (
    <div
      role="dialog"
      className="absolute z-50 top-full mt-2 left-0 w-[620px] max-w-[94vw] origin-top-left transition-all duration-150"
      style={{ opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(-6px)" }}
    >
      <div className="panel p-3 shadow-2xl">
        <div className="flex items-center justify-between mb-2">
          <span className="font-display font-semibold">Choose market</span>
          <span className="text-[10px] text-muted-foreground">Esc to close</span>
        </div>
        <div className="flex items-center gap-2 mb-2.5 px-2.5 py-2 rounded-md border border-border bg-background/60">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="bg-transparent text-xs w-full focus:outline-none"
          />
        </div>
        {/* category chips */}
        <div className="flex items-center gap-1 mb-2 overflow-x-auto">
          {cats.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setCat(id)}
              className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap ${
                cat === id
                  ? "bg-panel-2 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* sortable column headers */}
        <div
          className={`grid ${COLS} gap-2 text-[10px] uppercase tracking-[0.06em] text-muted-foreground px-1 pb-1.5 border-b border-border/60`}
        >
          <span />
          <span>Market</span>
          <button onClick={() => onSort("price")} className="text-right hover:text-foreground">
            Price{arrow("price")}
          </button>
          <button
            onClick={() => onSort("change")}
            className="hidden sm:block text-right hover:text-foreground"
          >
            24h{arrow("change")}
          </button>
          <button
            onClick={() => onSort("volume")}
            className="hidden md:block text-right hover:text-foreground"
          >
            Volume{arrow("volume")}
          </button>
          <button
            onClick={() => onSort("funding")}
            className="hidden md:block text-right hover:text-foreground"
          >
            APR{arrow("funding")}
          </button>
        </div>
        <div className="max-h-[340px] overflow-y-auto">
          {list.map((m) => {
            const ch = changeOf(m);
            const sel = marketKey(m) === marketKey(current);
            const apr = annFunding(m);
            return (
              <button
                key={marketKey(m)}
                onClick={() => onSelect(marketKey(m))}
                className={`w-full grid ${COLS} gap-2 items-center px-1 py-2 text-left rounded row-hover ${sel ? "bg-[oklch(0.86_0.16_188_/_0.06)]" : ""}`}
              >
                <span
                  onClick={(e) => toggleFav(m.base, e)}
                  className="grid place-items-center"
                  role="button"
                >
                  <Star
                    className={`h-3.5 w-3.5 ${isFav(m) ? "fill-amber text-amber" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
                  />
                </span>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="h-5 w-5 shrink-0 rounded-full grid place-items-center text-[9px] font-bold text-neon-foreground bg-gradient-to-br from-neon to-[var(--neon-dim)]">
                    {m.base.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-[13px] truncate block leading-tight">
                      {m.base}
                    </span>
                    <span className="inline-flex items-center gap-1 mt-0.5">
                      <span className="text-[9px] px-1 py-px rounded bg-panel-2 text-muted-foreground">
                        {m.maxLeverage ?? 20}x
                      </span>
                      <span className="text-[9px] px-1 py-px rounded bg-panel-2 text-muted-foreground">
                        {m.cexSymbol ? "Perp" : "Custom"}
                      </span>
                    </span>
                  </span>
                </span>
                <span className="text-right font-mono text-[12.5px] tabular-nums">
                  {fmtP(priceOf(m))}
                </span>
                <span
                  className={`hidden sm:block text-right font-mono text-[12px] tabular-nums ${ch === null ? "text-muted-foreground" : ch >= 0 ? "text-success" : "text-danger"}`}
                >
                  {ch === null ? "-" : `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`}
                </span>
                <span className="hidden md:block text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                  {volOf(m) > 0 ? fmtUsd(volOf(m)) : "-"}
                </span>
                <span
                  className={`hidden md:block text-right font-mono text-[12px] tabular-nums ${apr === 0 ? "text-muted-foreground" : apr >= 0 ? "text-success" : "text-danger"}`}
                >
                  {apr === 0 ? "-" : `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}%`}
                </span>
              </button>
            );
          })}
          {list.length === 0 && (
            <div className="py-6 text-center text-[11px] text-muted-foreground">No markets.</div>
          )}
        </div>
      </div>
    </div>
  );
}

const FAV_KEY = "openperps:favorites";
function loadFavs(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(FAV_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveFavs(s: Set<string>): void {
  if (typeof window !== "undefined") window.localStorage.setItem(FAV_KEY, JSON.stringify([...s]));
}

/// Right rail beside the chart: reference Order Book (Binance mirror) and the
/// market's global Trades feed, as two tabs, like Hyperliquid.
function RightRail({ market }: { market: Market }) {
  const [tab, setTab] = useState<"book" | "trades">(market.cexSymbol ? "book" : "trades");
  return (
    <div className="panel p-3 lg:h-full">
      <div className="flex gap-1 mb-2 -mt-0.5 text-xs">
        {market.cexSymbol && (
          <button
            onClick={() => setTab("book")}
            className={`px-2 py-1 rounded ${tab === "book" ? "text-neon bg-[oklch(0.86_0.16_188_/_0.10)]" : "text-muted-foreground hover:text-foreground"}`}
          >
            Order Book
          </button>
        )}
        <button
          onClick={() => setTab("trades")}
          className={`px-2 py-1 rounded ${tab === "trades" ? "text-neon bg-[oklch(0.86_0.16_188_/_0.10)]" : "text-muted-foreground hover:text-foreground"}`}
        >
          Trades
        </button>
      </div>
      {tab === "book" && market.cexSymbol ? (
        <OrderBook symbol={market.cexSymbol} base={market.base} />
      ) : (
        <TradesFeed market={market} />
      )}
    </div>
  );
}

function Cell({ k, v, cls, sub }: { k: string; v: string; cls?: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className={`font-mono text-sm ${cls ?? ""}`}>{v}</div>
      {sub && <div className="text-[9px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/// The center chart: real candles + this user's position overlays (entry /
/// liq lines, buy-sell markers, live PnL). Isolated so its position/trade
/// hooks only run once a market is selected.
function ChartPanel({ market }: { market: Market }) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58() ?? "";
  // Deterministic PDA for (owner, market), derivable on any device.
  const portfolioPk = owner ? userPortfolio(owner, market.pubkey) : undefined;
  const posQ = usePortfolioPositions(portfolioPk);
  const stateQ = usePortfolioState(portfolioPk);
  const entriesQ = useQuery({
    queryKey: ["pos-entries", owner],
    enabled: !!owner,
    queryFn: () => fetchPositionEntries(owner),
    refetchInterval: 15_000,
  });
  const globalQ = useQuery({
    queryKey: ["chart-trades"],
    queryFn: () => fetchGlobalTrades(60),
    refetchInterval: 15_000,
  });
  const local = useTrades();

  // Continuous display price: Pyth Hermes for majors, Jupiter (by mint) for
  // custom mainnet tokens, on-chain mark otherwise.
  const live = useMarketMark(market);

  const overlay = useMemo<ChartOverlay>(() => {
    const pos = (posQ.data ?? []).find((p) => p.assetIndex === market.assetIndex);
    if (!pos) return null;
    const size = Number(pos.sizeQ) / 1_000_000;
    // Entry: indexer VWAP → this device's local fill price (stable) → live mark.
    // The local fallback keeps the entry line from riding the mark until the
    // fill is indexed.
    const groupMarket = market.ownGroup ? market.pubkey : SHARED_MARKET.toBase58();
    const entry =
      entriesQ.data?.get(entryKey(groupMarket, market.assetIndex))?.entry ??
      localVwapEntry(market.symbol, local) ??
      live;
    if (!entry || size <= 0) return null;
    // Liquidation estimate grounded in real on-chain collateral and the 5%
    // maintenance margin: the price at which equity hits maintenance. Honest
    // approximation for cross-margin (exact when this is the only position).
    const capital = stateQ.data ? Number(stateQ.data.capital) / 1_000_000 : 0;
    const notional = entry * size;
    const lossToLiq = capital - 0.05 * notional;
    let liq: number | undefined;
    if (capital > 0 && lossToLiq > 0) {
      liq = pos.side === 0 ? entry - lossToLiq / size : entry + lossToLiq / size;
      if (liq <= 0) liq = undefined;
    }
    return { side: pos.side, entry, size, liq };
  }, [posQ.data, entriesQ.data, stateQ.data, local, market.assetIndex, market.price]);

  const markers = useMemo<ChartMarker[]>(() => {
    const global = globalQ.data ?? [];
    // Match by GROUP account + slot, not slot alone: every custom market is on
    // asset slot 0 (as is SOL), so filtering by assetIndex only would paint a
    // brand-new market with every other slot-0 market's fills. `market.pubkey`
    // is the custom group (or SHARED_MARKET for majors).
    const fromGlobal = global
      .filter((t) => t.market === market.pubkey && t.assetIndex === market.assetIndex)
      .map((t) => ({ ts: t.ts, side: t.side, price: t.price }));
    const seen = new Set(global.map((t) => t.signature));
    const fromLocal = local
      .filter((t) => t.market === market.symbol && !seen.has(t.signature))
      .map((t) => ({ ts: t.ts, side: t.side === "buy" ? 0 : 1, price: t.price }));
    return [...fromGlobal, ...fromLocal];
  }, [globalQ.data, local, market.pubkey, market.assetIndex, market.symbol]);

  // Native chart for EVERY market (majors + custom). History comes from the
  // token's real DEX pool for custom markets (GeckoTerminal OHLCV via the cached
  // Worker proxy) and from Pyth for majors, see loadHistory(). The live candle
  // folds in `live` (the same mark the header shows, so the chart never disagrees
  // with the displayed price / liquidation overlay).
  return (
    <div className="panel p-3">
      <div className="relative h-[380px]">
        <TradingChart
          market={market}
          overlay={overlay}
          markers={markers}
          livePrice={live}
          className="h-full"
        />
      </div>
    </div>
  );
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/// Recent fills on this market, REAL trades on the OpenPerps program (indexer
/// global feed), so you see other wallets' activity, not just your own.
function TradesFeed({ market }: { market: Market }) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58() ?? "";
  const local = useTrades();
  const globalQ = useQuery({
    queryKey: ["trades-feed", market.pubkey, market.assetIndex],
    queryFn: () => fetchGlobalTrades(60),
    refetchInterval: 10_000,
  });

  // Match by GROUP account + slot (not slot alone): all custom markets share
  // slot 0, so a new market would otherwise show every slot-0 market's trades.
  const globalRows = (globalQ.data ?? [])
    .filter((t) => t.market === market.pubkey && t.assetIndex === market.assetIndex)
    .map((t) => ({
      signature: t.signature,
      ts: t.ts,
      account: t.trader,
      long: t.side === 0,
      price: t.price,
      size: t.size,
      notional: t.notional,
    }));
  const seen = new Set(globalRows.map((r) => r.signature));
  const localRows = local
    .filter((t) => t.market === market.symbol && !seen.has(t.signature))
    .map((t) => ({
      signature: t.signature,
      ts: t.ts,
      account: owner,
      long: t.side === "buy",
      price: t.price,
      size: t.size,
      notional: t.size * t.price,
    }));
  const rows = [...globalRows, ...localRows].sort((a, b) => b.ts - a.ts).slice(0, 18);

  if (rows.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="font-medium text-foreground">No trades yet on {market.symbol}</p>
        <p className="mt-1 text-[11px]">
          Real fills on the OpenPerps program appear here (indexed ~1 min). Open a position to seed
          the feed.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-[1.1fr_0.7fr_0.9fr_1fr_0.9fr_0.4fr] gap-2 text-[10px] uppercase tracking-[0.06em] text-muted-foreground pb-1.5 border-b border-border/60">
        <span>Account</span>
        <span>Type</span>
        <span className="text-right">USDC</span>
        <span className="text-right">{market.base}</span>
        <span className="text-right">Time</span>
        <span className="text-right">Txn</span>
      </div>
      {rows.map((t) => (
        <div
          key={t.signature}
          className="grid grid-cols-[1.1fr_0.7fr_0.9fr_1fr_0.9fr_0.4fr] gap-2 items-center py-1.5 text-[12px] border-b border-border/30"
        >
          <a
            href={`https://explorer.solana.com/address/${t.account}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-muted-foreground hover:text-neon truncate"
          >
            {fmtPubkey(t.account, 4, 4)}
          </a>
          <span className={`font-medium ${t.long ? "text-success" : "text-danger"}`}>
            {t.long ? "Buy" : "Sell"}
          </span>
          <span className="text-right font-mono tabular-nums">
            ${t.notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
          <span className="text-right font-mono tabular-nums text-muted-foreground">
            {t.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}
          </span>
          <span className="text-right font-mono text-muted-foreground">{timeAgo(t.ts)}</span>
          <span className="text-right">
            <a
              href={`https://explorer.solana.com/tx/${t.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neon hover:underline inline-flex items-center"
            >
              ↗
            </a>
          </span>
        </div>
      ))}
    </div>
  );
}
