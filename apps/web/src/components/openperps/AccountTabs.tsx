/// Hyperliquid-style account panel for the connected wallet (bottom of the
/// terminal). Tabs: Positions + Trade History are real (on-chain / indexer);
/// Funding + Liquidations are placeholders until the indexer parses those
/// events. No Balances / Open Orders / Order History, OpenPerps matches every
/// order against the vault immediately, so there are no resting orders and
/// "order history" == trade history.
///
/// Positions are aggregated across EVERY group the wallet trades: the shared
/// majors group AND each custom SPL market's own isolated group (each is a
/// separate portfolio account, keyed by its market pubkey). Reading only the
/// shared portfolio hid all custom-market positions.

import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Link } from "@tanstack/react-router";
import { PublicKey } from "@solana/web3.js";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import {
  decodePortfolioPositions,
  readU128LE,
  OFFSET_CAPITAL,
  type DecodedPosition,
} from "@opp-oss/sdk";

import { useMarketMark } from "@/lib/livePrice";
import {
  fetchUserTrades,
  fetchPositionEntries,
  fetchUserPortfolios,
  entryKey,
} from "@/lib/indexer";
import { userPortfolio } from "@/lib/program";
import { placeOrderFlow } from "@/lib/flows/placeOrderFlow";
import { addTrade, useTrades, localVwapEntry } from "@/lib/tradeLog";
import { GROUP_MAX_FEE_BPS, SHARED_MARKET } from "@/lib/sharedMarket";
import { fmtPubkey } from "@/lib/format";
import type { Market } from "@/lib/types";

type Tab = "positions" | "history" | "funding" | "liq";

/// A (portfolio account, group) the wallet has opened. `market` is set for a
/// custom isolated group (so its positions resolve to that market directly);
/// undefined for the shared majors group (positions resolve by asset slot).
type Group = { portfolio: string; market?: Market };

/// One open leg, already resolved to the market it belongs to and the portfolio
/// + group collateral that backs it (so Close can route correctly).
export type AggPosition = DecodedPosition & {
  portfolio: string;
  market?: Market;
  isCustom: boolean;
  capital: number;
};

export function useGroups(owner: string, markets: Market[]): Group[] {
  // Portfolios are deterministic PDAs [PORTFOLIO_SEED, owner, market], so the
  // groups are simply DERIVED for the shared majors group + every custom market
  //, identical on any device, no localStorage and no off-chain index needed.
  // The batched on-chain read (useAllPositions) drops the ones not initialized.
  // We additionally merge any indexer-reported portfolios that aren't at a
  // derived address, so LEGACY random-keypair accounts (pre-PDA) still resolve.
  const discoveredQ = useQuery({
    queryKey: ["user-portfolios", owner],
    enabled: !!owner,
    queryFn: () => fetchUserPortfolios(owner),
    refetchInterval: 60_000,
  });
  return useMemo(() => {
    if (!owner) return [];
    const sharedMarket = SHARED_MARKET.toBase58();
    const byPortfolio = new Map<string, Group>();
    // Derived PDAs: majors + each custom market.
    byPortfolio.set(userPortfolio(owner, sharedMarket), {
      portfolio: userPortfolio(owner, sharedMarket),
    });
    for (const m of markets) {
      if (!m.ownGroup) continue;
      const pf = userPortfolio(owner, m.pubkey);
      byPortfolio.set(pf, { portfolio: pf, market: m });
    }
    // Legacy random-keypair accounts (created before the PDA migration) that the
    // indexer saw, keep them visible so old positions/funds aren't orphaned.
    for (const d of discoveredQ.data ?? []) {
      if (byPortfolio.has(d.portfolio)) continue;
      if (d.market === sharedMarket) {
        byPortfolio.set(d.portfolio, { portfolio: d.portfolio });
      } else {
        const m = markets.find((mk) => mk.ownGroup && mk.pubkey === d.market);
        if (m) byPortfolio.set(d.portfolio, { portfolio: d.portfolio, market: m });
      }
    }
    return [...byPortfolio.values()];
  }, [owner, markets, discoveredQ.data]);
}

/// Decode positions + collateral for every group portfolio in one batched RPC
/// read, flattened into one list tagged with each leg's market.
export function useAllPositions(
  groups: Group[],
  bySlot: Map<number, Market>,
): UseQueryResult<AggPosition[]> {
  const { connection } = useConnection();
  const key = groups.map((g) => g.portfolio).join(",");
  return useQuery({
    queryKey: ["all-positions", key, connection.rpcEndpoint],
    enabled: groups.length > 0,
    refetchInterval: 5_000,
    queryFn: async () => {
      const infos = await connection.getMultipleAccountsInfo(
        groups.map((g) => new PublicKey(g.portfolio)),
      );
      const out: AggPosition[] = [];
      infos.forEach((info, i) => {
        if (!info) return;
        const g = groups[i]!;
        const data = new Uint8Array(info.data);
        const capital = Number(readU128LE(data, OFFSET_CAPITAL)) / 1_000_000;
        for (const p of decodePortfolioPositions(data)) {
          // Custom group → the leg is that market. Shared group → resolve by
          // asset slot (a major). assetIndex 0 collides between the two, so we
          // must NOT slot-resolve custom legs.
          const market = g.market ?? bySlot.get(p.assetIndex);
          out.push({
            ...p,
            portfolio: g.portfolio,
            market,
            isCustom: !!g.market,
            capital,
          });
        }
      });
      return out;
    },
  });
}

export function AccountTabs({ markets }: { markets: Market[] }) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58() ?? "";
  const groups = useGroups(owner, markets);
  // Slot → market for the SHARED majors group only. Custom own-group markets are
  // each on slot 0 and would shadow SOL (also slot 0) here; their legs resolve
  // via the group's own market instead, so they must be excluded.
  const bySlot = useMemo(
    () => new Map(markets.filter((m) => !m.ownGroup).map((m) => [m.assetIndex, m])),
    [markets],
  );
  const posQ = useAllPositions(groups, bySlot);
  const openCount = posQ.data?.length ?? 0;

  const [tab, setTab] = useState<Tab>("positions");
  const tabs: [Tab, string, number?][] = [
    ["positions", "Positions", openCount],
    ["history", "Trade History"],
    ["funding", "Funding"],
    ["liq", "Liquidations"],
  ];

  return (
    <div className="panel">
      <div className="flex gap-1 px-3 pt-2 border-b border-border/60 text-xs overflow-x-auto">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 -mb-px border-b-2 whitespace-nowrap inline-flex items-center gap-1.5 ${
              tab === k ? "border-neon text-neon" : "border-transparent text-muted-foreground"
            }`}
          >
            {l}
            {n ? (
              <span className="text-[9px] px-1 rounded bg-panel-2 text-foreground">{n}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="p-3 text-xs text-muted-foreground">
        {!wallet.connected ? (
          <Empty>Connect your wallet to see your account.</Empty>
        ) : groups.length === 0 ? (
          <Empty>
            No trading account yet -{" "}
            <Link to="/portfolio" className="text-neon underline">
              open one
            </Link>{" "}
            and deposit to trade. Custom markets each have their own account.
          </Empty>
        ) : tab === "positions" ? (
          <PositionsTab posQ={posQ} bySlot={bySlot} />
        ) : tab === "history" ? (
          <HistoryTab owner={owner} />
        ) : tab === "funding" ? (
          <NeedsIndexer
            title="Funding history"
            detail="payments paid/received per position when funding accrues"
          />
        ) : (
          <NeedsIndexer title="Liquidations" detail="liquidation events on your account" />
        )}
      </div>
    </div>
  );
}

function PositionsTab({
  posQ,
  bySlot,
}: {
  posQ: UseQueryResult<AggPosition[]>;
  bySlot: Map<number, Market>;
}) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const owner = wallet.publicKey?.toBase58() ?? "";
  const positions = posQ.data ?? [];
  // Indexer VWAP entries, keyed per (group, slot). Until the just-opened fill is
  // indexed (~1–2 min), each row falls back to the device's local trade log for
  // a STABLE entry (see PositionRow) rather than the live mark.
  const entriesQ = useQuery({
    queryKey: ["pos-entries", owner],
    enabled: !!owner,
    queryFn: () => fetchPositionEntries(owner),
    refetchInterval: 15_000,
  });
  const localTrades = useTrades();
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keyOf = (p: AggPosition) => `${p.portfolio}:${p.assetIndex}`;

  // Mark comes from each row (via useMarketMark, identical to the header) so the
  // close executes at the same live price the user sees.
  const close = async (p: AggPosition, mark: number) => {
    const m = p.market;
    if (mark <= 0) return;
    setError(null);
    setClosing(keyOf(p));
    try {
      const r = await placeOrderFlow({
        wallet,
        connection,
        params: {
          market: m ? new PublicKey(m.pubkey) : undefined,
          housePortfolio: m?.house ? new PublicKey(m.house) : undefined,
          userPortfolioPubkey: new PublicKey(p.portfolio),
          side: p.side === 0 ? 1 : 0, // opposite → flatten
          assetIndex: p.assetIndex,
          sizeQ: p.sizeQ,
          execPrice: BigInt(Math.round(mark * 1_000_000)),
          feeBps: BigInt(Math.min(m?.feeBps ?? 5, GROUP_MAX_FEE_BPS)),
          oraclePool:
            m?.oracleKind === "dex" && m.oraclePool ? new PublicKey(m.oraclePool) : undefined,
        },
      });
      addTrade({
        market: m?.symbol ?? `PERP #${p.assetIndex}`,
        side: p.side === 0 ? "sell" : "buy",
        price: mark,
        size: Number(p.sizeQ) / 1_000_000,
        signature: r.signature,
      });
      await posQ.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClosing(null);
    }
  };

  if (positions.length === 0) {
    return <Empty>No open positions. Open a Long or Short from the panel on the right.</Empty>;
  }

  const fmt = (n: number) =>
    n < 1 ? n.toFixed(6) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-[1.1fr_0.7fr_0.9fr_0.9fr_0.9fr_0.9fr_1.1fr_0.7fr] gap-2 text-[10px] uppercase tracking-[0.06em] text-muted-foreground pb-1.5 border-b border-border/60">
        <span>Coin</span>
        <span>Side</span>
        <span className="text-right">Size</span>
        <span className="text-right">Entry</span>
        <span className="text-right">Mark</span>
        <span className="text-right">Liq (est)</span>
        <span className="text-right">PnL</span>
        <span className="text-right">Close</span>
      </div>
      {positions.map((p) => {
        const m = p.market ?? bySlot.get(p.assetIndex);
        const groupMarket = p.isCustom && p.market ? p.market.pubkey : SHARED_MARKET.toBase58();
        const indexedEntry = entriesQ.data?.get(entryKey(groupMarket, p.assetIndex))?.entry;
        const localEntry = m ? localVwapEntry(m.symbol, localTrades) : null;
        const k = keyOf(p);
        return (
          <PositionRow
            key={k}
            p={p}
            m={m}
            indexedEntry={indexedEntry}
            localEntry={localEntry}
            fmt={fmt}
            closing={closing !== null}
            spinning={closing === k}
            onClose={(mark) => close(p, mark)}
          />
        );
      })}
      {error && <div className="mt-2 text-[11px] text-danger break-words">{error}</div>}
    </div>
  );
}

/// One position row. Its mark comes from `useMarketMark(m)`, the SAME hook the
/// market header uses, so for custom markets the position's Mark ticks in lock
/// step with the header (the realtime feed is shared per mint), instead of
/// sitting on the slow on-chain `m.price`. PnL / liq derive from that live mark.
const EMPTY_MARKET = { price: 0 } as const;
function PositionRow({
  p,
  m,
  indexedEntry,
  localEntry,
  fmt,
  closing,
  spinning,
  onClose,
}: {
  p: AggPosition;
  m: Market | undefined;
  indexedEntry: number | undefined;
  localEntry: number | null;
  fmt: (n: number) => string;
  closing: boolean;
  spinning: boolean;
  onClose: (mark: number) => void;
}) {
  const mark = useMarketMark(m ?? EMPTY_MARKET);
  const size = Number(p.sizeQ) / 1_000_000;
  // Entry priority: indexer VWAP (authoritative) → this device's local fill
  // price (stable, available instantly) → live mark (last resort). Falling back
  // to the local price instead of the mark stops the entry from tracking the
  // mark, and PnL from sitting at 0, in the minute before the indexer catches
  // up.
  const entry = indexedEntry ?? localEntry ?? (mark > 0 ? mark : null);
  const dir = p.side === 0 ? 1 : -1;
  const notional = entry ? entry * size : 0;
  const upnl = entry && mark > 0 ? (mark - entry) * size * dir : null;
  const pct = entry && mark > 0 ? ((mark - entry) / entry) * 100 * dir : null;
  // Liq estimate from this group's collateral & 5% maintenance margin.
  let liq: number | null = null;
  if (entry && p.capital > 0) {
    const lossToLiq = p.capital - 0.05 * notional;
    if (lossToLiq > 0) {
      const l = p.side === 0 ? entry - lossToLiq / size : entry + lossToLiq / size;
      liq = l > 0 ? l : null;
    }
  }
  const up = (upnl ?? 0) >= 0;
  return (
    <div className="grid grid-cols-[1.1fr_0.7fr_0.9fr_0.9fr_0.9fr_0.9fr_1.1fr_0.7fr] gap-2 items-center py-2 text-[12px] border-b border-border/30">
      <span className="font-medium text-foreground truncate">
        {m?.symbol ?? `PERP #${p.assetIndex}`}
      </span>
      <span className={p.side === 0 ? "text-success" : "text-danger"}>
        {p.side === 0 ? "Long" : "Short"}
      </span>
      <span className="text-right font-mono tabular-nums">{fmt(size)}</span>
      <span className="text-right font-mono tabular-nums text-muted-foreground">
        {entry ? fmt(entry) : "-"}
      </span>
      <span className="text-right font-mono tabular-nums">{mark > 0 ? fmt(mark) : "-"}</span>
      <span className="text-right font-mono tabular-nums text-danger/80">
        {liq ? fmt(liq) : "-"}
      </span>
      <span
        className={`text-right font-mono tabular-nums ${upnl === null ? "text-muted-foreground" : up ? "text-success" : "text-danger"}`}
      >
        {upnl === null
          ? "-"
          : `${up ? "+" : ""}${upnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}${
              pct === null ? "" : ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`
            }`}
      </span>
      <span className="text-right">
        <button
          onClick={() => onClose(mark)}
          disabled={closing}
          className="btn-ghost-border rounded px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-50"
        >
          {spinning ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Close
        </button>
      </span>
    </div>
  );
}

function HistoryTab({ owner }: { owner: string }) {
  const local = useTrades();
  const q = useQuery({
    queryKey: ["user-trades", owner],
    enabled: !!owner,
    queryFn: () => fetchUserTrades(owner, 50),
    refetchInterval: 12_000,
  });

  const rows = useMemo(() => {
    const indexed = (q.data ?? []).map((t) => ({
      signature: t.signature,
      ts: t.ts,
      long: t.side === 0,
      price: t.price,
      size: t.size,
      notional: t.notional,
      market: t.market,
    }));
    const seen = new Set(indexed.map((r) => r.signature));
    const localRows = local
      .filter((t) => !seen.has(t.signature))
      .map((t) => ({
        signature: t.signature,
        ts: t.ts,
        long: t.side === "buy",
        price: t.price,
        size: t.size,
        notional: t.size * t.price,
        market: t.market,
      }));
    return [...indexed, ...localRows].sort((a, b) => b.ts - a.ts).slice(0, 40);
  }, [q.data, local]);

  if (rows.length === 0) {
    return (
      <Empty>No trades yet on this account. Your fills will appear here (indexed ~1 min).</Empty>
    );
  }
  const fmt = (n: number) =>
    n < 1 ? n.toFixed(6) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-[1fr_0.7fr_0.9fr_0.9fr_0.9fr_0.4fr] gap-2 text-[10px] uppercase tracking-[0.06em] text-muted-foreground pb-1.5 border-b border-border/60">
        <span>Time</span>
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Value</span>
        <span className="text-right">Txn</span>
      </div>
      {rows.map((t) => (
        <div
          key={t.signature}
          className="grid grid-cols-[1fr_0.7fr_0.9fr_0.9fr_0.9fr_0.4fr] gap-2 items-center py-1.5 text-[12px] border-b border-border/30"
        >
          <span className="font-mono text-muted-foreground">
            {new Date(t.ts).toLocaleTimeString()}
          </span>
          <span className={t.long ? "text-success" : "text-danger"}>{t.long ? "Buy" : "Sell"}</span>
          <span className="text-right font-mono tabular-nums">{fmt(t.price)}</span>
          <span className="text-right font-mono tabular-nums text-muted-foreground">
            {fmt(t.size)}
          </span>
          <span className="text-right font-mono tabular-nums">
            ${t.notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
          <span className="text-right">
            <a
              href={`https://explorer.solana.com/tx/${t.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neon hover:underline"
            >
              ↗
            </a>
          </span>
        </div>
      ))}
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        {fmtPubkey(owner, 4, 4)} · fills from the indexer + this browser
      </div>
    </div>
  );
}

function NeedsIndexer({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="py-6 text-center">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[11px]">
        Needs the indexer to parse {detail}. Not wired yet, shown for parity, no fabricated data.
      </p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-[11px]">{children}</div>;
}
