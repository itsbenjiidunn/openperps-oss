/// Market-first discovery view — the default Terminal state. Traders search /
/// filter the listed pairs, then click one to open the chart + trade panels.
/// Only the fields the protocol actually knows are shown as real data; metrics
/// that need an indexer (24h volume, OI, change, trending rank) render "—" and
/// their sort tabs are disabled until the indexer lands.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search, Rocket, Lock } from "lucide-react";
import { fmtUsd } from "@/lib/format";
import { useLivePrices, normalizeFeedId } from "@/lib/livePrice";
import { fetch24hAgoPrice } from "@/lib/chartData";
import { fetchStats } from "@/lib/indexer";
import { useDexStatsMany } from "@/lib/dexscreener";
import { marketKey, type Market } from "@/lib/types";

type AssetType = "all" | "token" | "synthetic";
type LevTier = "all" | "5" | "10" | "20";
type OracleFilter = "all" | "pyth" | "dex" | "manual";
type Sort = "new" | "trending" | "volume" | "liquidity";

const SORTS: { key: Sort; label: string; live: boolean }[] = [
  { key: "new", label: "New", live: true },
  { key: "volume", label: "Volume", live: true },
  { key: "trending", label: "Trending", live: false },
  { key: "liquidity", label: "Liquidity", live: false },
];

/// Live per-market metrics. 24h change + volume come from DexScreener (keyed by
/// the token MINT) for every market that lists a real mainnet token — majors and
/// custom alike. This is the same source the chart and terminal header use, so
/// the numbers line up, AND it sidesteps the devnet indexer's asset-slot
/// collision: every custom group is asset slot 0 (as is SOL), so slot-keyed
/// indexed volume/refs would smear all slot-0 markets together (identical
/// volume, nonsense % change). Synthetic markets with no mint fall back to the
/// Pyth 24h-ago reference + indexed volume.
function useMarketMetrics(markets: Market[]) {
  const livePrices = useLivePrices(markets.map((m) => m.oracleFeedId));
  const dexQ = useDexStatsMany(markets.map((m) => m.baseMint).filter((x): x is string => !!x));
  const synthetic = markets.filter((m) => !m.baseMint);
  const refsQ = useQuery({
    queryKey: ["refs24h", synthetic.map((m) => m.base).join(",")],
    enabled: synthetic.length > 0,
    refetchInterval: 300_000,
    staleTime: 300_000,
    queryFn: async () => {
      const entries = await Promise.all(
        synthetic.map(async (m) => [m.assetIndex, await fetch24hAgoPrice(m)] as const),
      );
      return new Map(entries.filter((e): e is [number, number] => e[1] != null));
    },
  });
  const statsQ = useQuery({
    queryKey: ["stats24h"],
    queryFn: () => fetchStats(),
    refetchInterval: 30_000,
  });
  const priceOf = (m: Market) =>
    (m.oracleFeedId && livePrices.get(normalizeFeedId(m.oracleFeedId))) || m.price;
  const changeOf = (m: Market): number | null => {
    if (m.baseMint) {
      const d = dexQ.data?.get(m.baseMint);
      return d ? d.change24h : null;
    }
    const ref = refsQ.data?.get(m.assetIndex);
    const px = priceOf(m);
    return ref && ref > 0 && px > 0 ? ((px - ref) / ref) * 100 : null;
  };
  const volOf = (m: Market) => {
    if (m.baseMint) return dexQ.data?.get(m.baseMint)?.volume24h ?? 0;
    return statsQ.data?.[m.assetIndex]?.volume ?? 0;
  };
  return { priceOf, changeOf, volOf };
}

export function MarketBrowser({
  markets,
  onSelect,
}: {
  markets: Market[];
  onSelect: (key: string) => void;
}) {
  const [q, setQ] = useState("");
  const [asset, setAsset] = useState<AssetType>("all");
  const [lev, setLev] = useState<LevTier>("all");
  const [oracle, setOracle] = useState<OracleFilter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const { priceOf, changeOf, volOf } = useMarketMetrics(markets);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = markets.filter((m) => {
      if (asset === "token" && !m.baseMint) return false;
      if (asset === "synthetic" && m.baseMint) return false;
      if (lev !== "all" && (m.maxLeverage ?? 0) < Number(lev)) return false;
      if (oracle !== "all" && (m.oracleKind ?? "manual") !== oracle) return false;
      if (needle) {
        const hay = [m.symbol, m.base, m.baseMint ?? "", m.oraclePool ?? "", m.pubkey]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    out =
      sort === "volume"
        ? [...out].sort((a, b) => volOf(b) - volOf(a))
        : [...out].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, q, asset, lev, oracle, sort, volOf]);

  return (
    <div className="px-3 py-3 lg:px-4 max-w-6xl mx-auto space-y-3">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-muted-foreground">
            {markets.length} listed · pick a market to chart and trade
          </p>
        </div>
        <Link
          to="/launch"
          className="btn-ghost-border inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm"
        >
          <Rocket className="h-4 w-4" /> Launch market
        </Link>
      </header>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search symbol, base asset, or SPL mint address"
          className="w-full bg-background/60 border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-neon/60"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segment
          options={[
            ["all", "All"],
            ["token", "Tokens"],
            ["synthetic", "Synthetic"],
          ]}
          value={asset}
          onChange={setAsset}
        />
        <Segment
          options={[
            ["all", "All lev"],
            ["5", "5x+"],
            ["10", "10x+"],
            ["20", "20x+"],
          ]}
          value={lev}
          onChange={setLev}
        />
        <Segment
          options={[
            ["all", "All oracles"],
            ["pyth", "Pyth"],
            ["dex", "DEX-EWMA"],
            ["manual", "Manual"],
          ]}
          value={oracle}
          onChange={setOracle}
        />
      </div>

      {/* Sort tabs */}
      <div className="flex items-center gap-1 border-b border-border/60">
        {SORTS.map((s) => (
          <button
            key={s.key}
            disabled={!s.live}
            onClick={() => s.live && setSort(s.key)}
            title={s.live ? undefined : "Needs the indexer (Phase 2)"}
            className={[
              "px-3 py-1.5 -mb-px border-b-2 text-sm inline-flex items-center gap-1",
              sort === s.key && s.live
                ? "border-neon text-neon"
                : "border-transparent text-muted-foreground",
              s.live ? "hover:text-foreground" : "opacity-40 cursor-not-allowed",
            ].join(" ")}
          >
            {!s.live && <Lock className="h-3 w-3" />}
            {s.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState filtered={markets.length > 0} />
      ) : (
        <div className="panel overflow-hidden">
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted-foreground px-3 py-2 border-b border-border/60">
            <div className="flex-1 min-w-0">Market</div>
            <div className="w-20 sm:w-24 text-right">Price</div>
            <div className="hidden md:block w-14 text-right">24h</div>
            <div className="hidden lg:block w-24 text-right">Volume</div>
            <div className="hidden lg:block w-16 text-right">OI</div>
            <div className="w-10 text-right">Lev</div>
            <div className="hidden sm:flex w-[84px] justify-end">Oracle</div>
            <div className="hidden lg:block w-12 text-right">Age</div>
          </div>
          <ul>
            {rows.map((m) => {
              const px = priceOf(m);
              const ch = changeOf(m);
              const vol = volOf(m);
              return (
                <li
                  key={marketKey(m)}
                  onClick={() => onSelect(marketKey(m))}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer row-hover border-t border-border/30"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{m.symbol}</span>
                      {isNew(m.createdAt) && (
                        <span className="text-[9px] uppercase tracking-wide rounded px-1 py-px bg-[oklch(0.86_0.16_188_/_0.12)] text-neon">
                          New
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {m.base} · {m.baseMint ? "Token" : "Synthetic"}
                    </div>
                  </div>
                  <div className="w-20 sm:w-24 text-right font-mono">
                    {px === 0
                      ? "—"
                      : px < 1
                        ? `$${px.toFixed(6)}`
                        : `$${px.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </div>
                  <div
                    className={`hidden md:block w-14 text-right font-mono ${ch === null ? "text-muted-foreground" : ch > 0 ? "text-success" : ch < 0 ? "text-danger" : "text-muted-foreground"}`}
                  >
                    {ch === null ? "—" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}
                  </div>
                  <div className="hidden lg:block w-24 text-right font-mono text-muted-foreground">
                    {vol > 0 ? fmtUsd(vol) : "—"}
                  </div>
                  <div className="hidden lg:block w-16 text-right font-mono text-muted-foreground">
                    {m.openInterest === 0 ? "—" : fmtUsd(m.openInterest)}
                  </div>
                  <div className="w-10 text-right font-mono">
                    {m.maxLeverage ? `${m.maxLeverage}x` : "—"}
                  </div>
                  <div className="hidden sm:flex w-[84px] justify-end">
                    <OracleBadge kind={m.oracleKind} status={m.oracleStatus} />
                  </div>
                  <div className="hidden lg:block w-12 text-right font-mono text-[11px] text-muted-foreground">
                    {fmtAge(m.createdAt)}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Price is live (Pyth for majors, on-chain pool for custom). 24h change / volume / liquidity
        come from DexScreener, keyed by the token mint, so every surface shows the same number.
        Synthetic perps with no token fall back to the Pyth 24h reference. Open interest is
        on-chain.
      </p>
    </div>
  );
}

function Segment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md bg-background/40 p-0.5 border border-border/60">
      {options.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
            value === k
              ? "bg-[oklch(0.86_0.16_188_/_0.14)] text-neon"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function OracleBadge({ kind, status }: { kind?: "pyth" | "manual" | "dex"; status: string }) {
  const label = kind === "pyth" ? "Pyth" : kind === "dex" ? "DEX-EWMA" : "Manual";
  const dot = status === "live" ? "bg-success" : status === "stale" ? "bg-danger" : "bg-violet";
  return (
    <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] bg-background/60 border border-border/60">
      <span className={`h-1 w-1 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function isNew(createdAt?: number): boolean {
  if (!createdAt) return false;
  return Date.now() - createdAt < 24 * 60 * 60 * 1000;
}

function fmtAge(createdAt?: number): string {
  if (!createdAt) return "—";
  const s = Math.floor((Date.now() - createdAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="panel p-10 text-center space-y-4">
      <div className="mx-auto h-12 w-12 rounded-full bg-[oklch(0.86_0.16_188_/_0.10)] flex items-center justify-center">
        <Rocket className="h-6 w-6 text-neon" />
      </div>
      <h2 className="font-display text-xl font-semibold">
        {filtered ? "No markets match these filters" : "No markets yet"}
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        {filtered
          ? "Try clearing the filters or search. "
          : "OpenPerps is permissionless on devnet. Spin up a perp market against any SPL mint. "}
        Launch your first one to start trading.
      </p>
      <Link
        to="/launch"
        className="btn-primary inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
      >
        <Rocket className="h-4 w-4" /> Launch a market
      </Link>
    </div>
  );
}
