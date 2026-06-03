/// Cross-margin account view, styled after the reference design. One account,
/// one deposit, collateral backs every pair. Numbers shown are real on-chain
/// values (collateral, PnL); metrics that need an indexer (equity history,
/// realized PnL, 24h funding/fees) are labelled rather than fabricated.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/openperps/WalletButton";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ExternalLink,
  Loader2,
  Rocket,
  Wallet,
  Wallet2,
  X,
} from "lucide-react";

import { readU128LE, OFFSET_CAPITAL } from "@openperps/sdk";

import { fmtPubkey } from "@/lib/format";
import { useMarkets, usePortfolioState } from "@/lib/onchain";
import type { Market } from "@/lib/types";
import { userPortfolio } from "@/lib/program";
import { depositFlow, initPortfolioFlow, withdrawFlow } from "@/lib/flows/portfolioFlows";
import { useLivePrices, normalizeFeedId } from "@/lib/livePrice";
import { placeOrderFlow } from "@/lib/flows/placeOrderFlow";
import { addTrade, useTrades, localVwapEntry } from "@/lib/tradeLog";
import { fetchFees24h, fetchEquity, fetchPositionEntries, entryKey } from "@/lib/indexer";
import { useGroups, useAllPositions, type AggPosition } from "@/components/openperps/AccountTabs";
import { atomsToHuman, humanToAtoms } from "@/lib/decimals";
import { QUOTE_MINT, QUOTE_SYMBOL } from "@/lib/collateral";
import {
  GROUP_MAX_FEE_BPS,
  SHARED_MARKET,
  SHARED_SLOT_CAPACITY,
  SHARED_VAULT,
} from "@/lib/sharedMarket";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio: OpenPerps" },
      {
        name: "description",
        content:
          "Cross-margin account: one deposit backs trades on every pair against the shared LP & Insurance Vault.",
      },
    ],
  }),
  component: Portfolio,
});

function Portfolio() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const marketsQ = useMarkets();
  const markets = marketsQ.data ?? [];
  const [tab, setTab] = useState<"deposit" | "withdraw" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const ownerKey = wallet.publicKey?.toBase58();
  // Main (majors) account is the deterministic PDA for (owner, SHARED_MARKET),
  // same address on every device. Existence is the on-chain state, not a local
  // registry. (Hook runs before the connect gate so hook order stays stable.)
  const mainPortfolio = ownerKey ? userPortfolio(ownerKey, SHARED_MARKET.toBase58()) : undefined;
  const mainStateQ = usePortfolioState(mainPortfolio);

  if (!wallet.connected) return <ConnectGate />;

  const owner = wallet.publicKey!.toBase58();
  // `null` = confirmed not yet opened; while loading stay optimistic so the
  // Deposit/Withdraw header and account view don't flash the open-account card.
  const hasMain = mainStateQ.data !== null;
  const portfolio = hasMain && mainPortfolio ? { pubkey: mainPortfolio } : undefined;

  return (
    <div className="px-4 py-6 max-w-6xl mx-auto space-y-4">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            Majors cross-margin account ·{" "}
            <span className="font-mono">{fmtPubkey(owner, 6, 6)}</span>. Custom markets each have
            their own account, funded from your wallet in the terminal.
          </p>
        </div>
        {portfolio && (
          <div className="flex gap-2">
            <button
              onClick={() => setTab(tab === "deposit" ? null : "deposit")}
              className={`rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 ${
                tab === "deposit" ? "btn-primary" : "btn-ghost-border"
              }`}
            >
              <ArrowDownToLine className="h-4 w-4" /> Deposit {QUOTE_SYMBOL}
            </button>
            <button
              onClick={() => setTab(tab === "withdraw" ? null : "withdraw")}
              className={`rounded-md px-4 py-2 text-sm inline-flex items-center gap-1.5 ${
                tab === "withdraw" ? "btn-primary" : "btn-ghost-border"
              }`}
            >
              <ArrowUpFromLine className="h-4 w-4" /> Withdraw
            </button>
          </div>
        )}
      </header>

      {!portfolio ? (
        <OpenAccountCard onDone={() => setRefresh((n) => n + 1)} key={refresh} />
      ) : (
        <AccountView
          portfolio={portfolio.pubkey}
          markets={markets}
          tab={tab}
          onClose={() => setTab(null)}
          connection={connection}
        />
      )}
    </div>
  );
}

/// Where the wallet's {QUOTE_SYMBOL} is sitting: the main (majors) account plus
/// every custom-market account it has funded, with a total. Each isolated market
/// holds its own collateral, so this is the one place to see it all.
function AccountsSummary({ markets }: { markets: Market[] }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const owner = wallet.publicKey?.toBase58() ?? "";

  // Same cross-device discovery as positions: merge the local registry with the
  // indexer-reported (portfolio, market) pairs so every market account shows on
  // any browser, not just the one that created it.
  const groups = useGroups(owner, markets);
  const accounts = useMemo(() => {
    return groups.map((g) =>
      g.market
        ? { label: g.market.symbol, sub: "isolated market", portfolio: g.portfolio }
        : { label: "Main account", sub: "majors · BTC SOL ETH JUP", portfolio: g.portfolio },
    );
  }, [groups]);

  const q = useQuery({
    queryKey: [
      "accounts-capital",
      accounts.map((a) => a.portfolio).join(","),
      connection.rpcEndpoint,
    ],
    enabled: accounts.length > 0,
    refetchInterval: 8_000,
    queryFn: async () => {
      const infos = await connection.getMultipleAccountsInfo(
        accounts.map((a) => new PublicKey(a.portfolio)),
      );
      return accounts.map((a, i) => {
        const info = infos[i];
        const capital = info
          ? Number(readU128LE(new Uint8Array(info.data), OFFSET_CAPITAL)) / 1_000_000
          : 0;
        return { ...a, capital };
      });
    },
  });

  const rows = (q.data ?? []).filter((r) => r.capital > 0);
  const total = rows.reduce((s, r) => s + r.capital, 0);

  if (accounts.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Your accounts</h2>
          <p className="text-[11px] text-muted-foreground">
            {QUOTE_SYMBOL} is held per market, majors share one account, each custom market its
            own.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
          <div className="font-mono text-xl text-neon">
            ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground py-2">
          No collateral in any account yet. Deposit to your main account or fund a custom market in
          the terminal.
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {rows
            .sort((a, b) => b.capital - a.capital)
            .map((r) => (
              <div key={r.portfolio} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">{r.label}</div>
                  <div className="text-[11px] text-muted-foreground">{r.sub}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm">
                    ${r.capital.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {total > 0 ? `${((r.capital / total) * 100).toFixed(0)}%` : ""}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function AccountView({
  portfolio,
  markets,
  tab,
  onClose,
  connection,
}: {
  portfolio: string;
  markets: Market[];
  tab: "deposit" | "withdraw" | null;
  onClose: () => void;
  connection: import("@solana/web3.js").Connection;
}) {
  const pairs = markets.length;
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58();
  const feesQ = useQuery({
    queryKey: ["fees24h", owner],
    enabled: !!owner,
    queryFn: () => fetchFees24h(owner!),
    refetchInterval: 30_000,
  });
  const stateQ = usePortfolioState(portfolio);
  const capital = stateQ.data?.capital ?? null;
  const pnl = stateQ.data?.pnl ?? null;
  const collateral = capital !== null ? atomsToHuman(capital, undefined, true) : "-";
  const realized =
    pnl !== null ? `${pnl >= 0n ? "+" : ""}${atomsToHuman(pnl, undefined, true)}` : "-";
  const equity =
    capital !== null && pnl !== null ? atomsToHuman(capital + pnl, undefined, true) : "-";

  // Unrealized = Σ (mark − VWAP entry) × size × side across EVERY group the
  // wallet trades (majors + each custom market), entry resolved per (group,
  // slot) so custom legs (all slot 0) don't collide.
  const groups = useGroups(owner ?? "", markets);
  // Majors-only slot map (custom own-group markets share slot 0 with SOL and
  // would shadow it); custom legs resolve via their own group market.
  const bySlot = useMemo(
    () => new Map(markets.filter((m) => !m.ownGroup).map((m) => [m.assetIndex, m])),
    [markets],
  );
  const posQ = useAllPositions(groups, bySlot);
  const entriesQ = useQuery({
    queryKey: ["pos-entries", owner],
    enabled: !!owner,
    queryFn: () => fetchPositionEntries(owner!),
    refetchInterval: 15_000,
  });
  // Live marks (Pyth stream) for the markets this account holds, so unrealized
  // PnL ticks continuously instead of stepping with the 1-min on-chain mark.
  const livePrices = useLivePrices((posQ.data ?? []).map((p) => p.market?.oracleFeedId));
  let unrealizedTotal: number | null = null;
  if (entriesQ.data) {
    unrealizedTotal = (posQ.data ?? []).reduce((sum, p) => {
      const m = p.market ?? bySlot.get(p.assetIndex);
      const mark =
        (m?.oracleFeedId && livePrices.get(normalizeFeedId(m.oracleFeedId))) || m?.price || 0;
      const groupMarket = p.isCustom && p.market ? p.market.pubkey : SHARED_MARKET.toBase58();
      const entry = entriesQ.data!.get(entryKey(groupMarket, p.assetIndex))?.entry;
      if (entry == null || mark <= 0) return sum;
      const size = Number(p.sizeQ) / 1_000_000;
      return sum + (mark - entry) * size * (p.side === 0 ? 1 : -1);
    }, 0);
  }

  return (
    <div className="space-y-4">
      {tab && (
        <TransferModal
          kind={tab}
          market={SHARED_MARKET}
          vault={SHARED_VAULT}
          assetSlotCapacity={SHARED_SLOT_CAPACITY}
          portfolio={portfolio}
          capital={capital}
          pnl={pnl}
          title="Majors · shared account"
          onClose={onClose}
        />
      )}

      {/* KPI row */}
      <div className="grid md:grid-cols-4 gap-3">
        <Kpi label={`Balance (${QUOTE_SYMBOL})`} value={`$${equity}`} accent />
        <Kpi label="Withdrawable" value={`$${equity}`} />
        <Kpi label="Margin ratio" value={pairs === 0 ? "-" : "0.0%"} />
        <Kpi
          label="Account health"
          value={capital !== null && capital > 0n ? "100%" : "-"}
          className="text-success"
        />
      </div>

      {/* equity + realized/unrealized */}
      <div className="grid lg:grid-cols-3 gap-3">
        <div className="panel p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm">
              Equity{" "}
              <span className="text-[11px] text-muted-foreground">
                · ${equity} {QUOTE_SYMBOL}
              </span>
            </div>
          </div>
          <AccountsSummary markets={markets} />
        </div>

        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-3">
            Realized vs unrealized
          </div>
          <div className="space-y-2.5 text-sm">
            <KV
              k="Realized PnL"
              v={`${realized} ${QUOTE_SYMBOL}`}
              cls={pnl !== null && pnl < 0n ? "text-danger" : "text-success"}
            />
            <KV
              k="Unrealized PnL"
              v={
                unrealizedTotal != null
                  ? `${unrealizedTotal >= 0 ? "+" : ""}$${unrealizedTotal.toFixed(2)}`
                  : "-"
              }
              cls={
                unrealizedTotal == null
                  ? undefined
                  : unrealizedTotal >= 0
                    ? "text-success"
                    : "text-danger"
              }
              muted={unrealizedTotal == null}
            />
            <KV k="Net funding (24h)" v="-" muted />
            <KV
              k="Fees paid (24h)"
              v={feesQ.data != null ? `$${feesQ.data.toFixed(2)} ${QUOTE_SYMBOL}` : "-"}
              muted={feesQ.data == null}
            />
          </div>
          <div className="mt-4 p-3 panel-flat text-[11px] text-muted-foreground">
            Realized PnL (engine ledger) + fees are live. Unrealized PnL is the mark-vs-VWAP-entry
            on open positions (entry from your indexed fills). Funding accrues on-chain and folds
            into Realized PnL. Settled to the shared USDC vault.
          </div>
        </div>
      </div>

      {/* open positions */}
      <PositionsTable markets={markets} />

      <AccountFooter portfolio={portfolio} connection={connection} />
    </div>
  );
}

function EquityChart({ portfolio, fallbackEquity }: { portfolio: string; fallbackEquity: string }) {
  const q = useQuery({
    queryKey: ["equity", portfolio],
    queryFn: () => fetchEquity(portfolio),
    refetchInterval: 30_000,
  });
  const points = q.data ?? [];

  if (points.length < 2) {
    return (
      <div className="h-[260px] flex flex-col items-center justify-center text-center gap-2">
        <div className="font-mono text-2xl">${fallbackEquity}</div>
        <p className="text-[11px] text-muted-foreground max-w-xs">
          Building equity history, the indexer snapshots your account every ~1 minute. The curve
          appears once there are a few points.
        </p>
      </div>
    );
  }

  const vals = points.map((p) => p.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 600;
  const H = 240;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * (H - 16) - 8;
  const line = points.map((p, i) => `${x(i)},${y(p.equity)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  const up = vals[vals.length - 1]! >= vals[0]!;
  const color = up ? "var(--success)" : "var(--danger)";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[260px]" preserveAspectRatio="none">
      <polyline points={area} fill={color} opacity={0.08} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/// Every open leg the wallet holds, across the shared majors account AND each
/// custom isolated-market account (each its own group/portfolio). Reads on-chain
/// positions for all groups in one batched RPC, resolves entry per (group, slot)
/// so custom markets, all on slot 0, no longer collide, and routes Close back
/// to the group that backs each leg.
function PositionsTable({ markets }: { markets: Market[] }) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58();
  const { connection } = useConnection();
  const groups = useGroups(owner ?? "", markets);
  // Majors-only slot map, see note above; custom legs carry their own market.
  const bySlot = useMemo(
    () => new Map(markets.filter((m) => !m.ownGroup).map((m) => [m.assetIndex, m])),
    [markets],
  );
  const posQ = useAllPositions(groups, bySlot);
  const positions = posQ.data ?? [];
  const entriesQ = useQuery({
    queryKey: ["pos-entries", owner],
    enabled: !!owner,
    queryFn: () => fetchPositionEntries(owner!),
    refetchInterval: 15_000,
  });
  const localTrades = useTrades();
  // Live marks (Pyth for majors) so PnL ticks continuously; custom legs use
  // their resolved market price (DexScreener/on-chain feed via useMarketMark).
  const livePrices = useLivePrices(positions.map((p) => p.market?.oracleFeedId));
  const markOf = (m: Market | undefined) =>
    (m?.oracleFeedId && livePrices.get(normalizeFeedId(m.oracleFeedId))) || m?.price || 0;
  const groupMarketOf = (p: AggPosition) =>
    p.isCustom && p.market ? p.market.pubkey : SHARED_MARKET.toBase58();
  const keyOf = (p: AggPosition) => `${p.portfolio}:${p.assetIndex}`;
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClosePosition = async (p: AggPosition) => {
    const m = p.market;
    const mark = markOf(m);
    if (mark <= 0) {
      setError("No live mark for this market, cannot close.");
      return;
    }
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
          // opposite side, full size → flatten the leg
          side: p.side === 0 ? 1 : 0,
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
        // closing a long = sell, closing a short = buy
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

  return (
    <div className="panel p-4">
      <div className="text-sm mb-3">
        Open positions{positions.length > 0 ? ` (${positions.length})` : ""}
      </div>
      {positions.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm text-foreground">No open positions</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Open a Long or Short from the Terminal, majors share one account, each custom market
            its own.
          </p>
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left py-1.5 font-normal">Market</th>
              <th className="text-left font-normal">Side</th>
              <th className="text-right font-normal">Size</th>
              <th className="text-right font-normal">Notional</th>
              <th className="text-right font-normal">Entry</th>
              <th className="text-right font-normal">Mark</th>
              <th className="text-right font-normal">Liq.</th>
              <th className="text-right font-normal">PnL</th>
              <th className="text-right font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const m = p.market ?? bySlot.get(p.assetIndex);
              const symbol = m?.symbol ?? `PERP #${p.assetIndex}`;
              const base = m?.base ?? `SLOT${p.assetIndex}`;
              const mark = markOf(m);
              const lev = m?.maxLeverage ?? 10;
              const size = Number(p.sizeQ) / 1_000_000;
              const isLong = p.side === 0;
              // Entry: indexer VWAP → this device's local fill price (stable,
              // instant) → live mark. The local fallback keeps the entry from
              // tracking the mark (PnL stuck at 0) before the fill is indexed.
              const entry =
                entriesQ.data?.get(entryKey(groupMarketOf(p), p.assetIndex))?.entry ??
                (m ? (localVwapEntry(m.symbol, localTrades) ?? undefined) : undefined) ??
                (mark > 0 ? mark : undefined);
              const notional = (entry ?? mark) * size;
              const unrealized =
                entry != null && mark > 0 ? (mark - entry) * size * (isLong ? 1 : -1) : null;
              const liq =
                entry != null ? (isLong ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev)) : null;
              const fmtP = (v: number) => (v < 1 ? v.toFixed(6) : v.toFixed(2));
              const k = keyOf(p);
              return (
                <tr key={k} className="border-t border-border/30 row-hover">
                  <td className="py-2 font-medium">{symbol}</td>
                  <td className={isLong ? "text-success" : "text-danger"}>
                    {isLong ? "LONG" : "SHORT"}
                  </td>
                  <td className="text-right font-mono">
                    {size.toLocaleString(undefined, {
                      maximumFractionDigits: 6,
                    })}{" "}
                    {base}
                  </td>
                  <td className="text-right font-mono">
                    ${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right font-mono">{entry != null ? fmtP(entry) : "-"}</td>
                  <td className="text-right font-mono">{mark > 0 ? fmtP(mark) : "-"}</td>
                  <td className="text-right font-mono text-danger">
                    {liq != null ? fmtP(liq) : "-"}
                  </td>
                  <td
                    className={`text-right font-mono ${
                      unrealized == null ? "" : unrealized >= 0 ? "text-success" : "text-danger"
                    }`}
                  >
                    {unrealized != null
                      ? `${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)}`
                      : "-"}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => onClosePosition(p)}
                      disabled={closing !== null}
                      className="btn-ghost-border rounded-md px-2.5 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      {closing === k ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error && <div className="mt-2 text-[11px] text-danger break-words">{error}</div>}
      {positions.length > 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Size + mark are live from the engine; entry / liq / unrealized PnL are derived from your
          indexed fills (VWAP entry). Includes every market account, majors and custom.
        </p>
      )}
    </div>
  );
}

function AccountFooter({
  portfolio,
  connection,
}: {
  portfolio: string;
  connection: import("@solana/web3.js").Connection;
}) {
  const vaultQ = useTokenBalance(connection, SHARED_VAULT.toBase58());
  return (
    <div className="flex items-center justify-between flex-wrap gap-2 text-[11px] text-muted-foreground">
      <span>
        account{" "}
        <a
          href={`https://explorer.solana.com/address/${portfolio}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono hover:text-neon inline-flex items-center gap-1"
        >
          {fmtPubkey(portfolio, 6, 6)}
          <ExternalLink className="h-3 w-3" />
        </a>
      </span>
      <span className="font-mono">
        shared vault TVL:{" "}
        {vaultQ.data !== undefined
          ? `${atomsToHuman(vaultQ.data, undefined, true)} ${QUOTE_SYMBOL}`
          : "-"}
      </span>
    </div>
  );
}

function TransferModal({
  kind,
  market,
  vault,
  assetSlotCapacity,
  portfolio,
  capital,
  pnl,
  title,
  onClose,
  onDone,
}: {
  kind: "deposit" | "withdraw";
  /// The group this transfer targets (shared majors or a custom isolated one).
  market: PublicKey;
  vault: PublicKey;
  assetSlotCapacity: number;
  /// Null when the wallet has no account in this group yet, a deposit opens
  /// one first (InitPortfolio), then deposits into it.
  portfolio: string | null;
  capital: bigint | null;
  /// Realized PnL ledger. Withdraw settles it into capital first (SettlePnl), so
  /// the withdrawable max is capital + pnl (= equity), not just capital.
  pnl?: bigint | null;
  title: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const balanceQ = useWalletTokenBalance();
  const [amount, setAmount] = useState("");
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isDeposit = kind === "deposit";
  // Max = wallet balance (deposit) or equity = capital + realized PnL (withdraw).
  // The withdraw tx runs SettlePnl first, folding realized profit into capital,
  // so the full equity is withdrawable, not just the pre-settle collateral.
  const equityAtoms = (capital ?? 0n) + (pnl ?? 0n);
  const withdrawMax = equityAtoms > 0n ? equityAtoms : 0n;
  const maxAtoms = isDeposit ? (balanceQ.data ?? 0n) : withdrawMax;

  const amountAtoms = (() => {
    try {
      return humanToAtoms(amount || "0");
    } catch {
      return 0n;
    }
  })();
  const valid = amountAtoms > 0n && amountAtoms <= maxAtoms;

  const setPct = (pct: number) =>
    setAmount(atomsToHuman((maxAtoms * BigInt(pct)) / 100n, undefined, true));

  const newCollateral =
    capital !== null
      ? isDeposit
        ? capital + amountAtoms
        : capital - (amountAtoms > capital ? capital : amountAtoms)
      : null;

  const onSubmit = async () => {
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      // A deposit into a group where this wallet has no account yet opens one
      // first (custom isolated markets each need their own account).
      let portfolioPubkey = portfolio ? new PublicKey(portfolio) : null;
      if (isDeposit && !portfolioPubkey) {
        const pf = await initPortfolioFlow({
          wallet,
          connection,
          params: { marketPubkey: market, assetSlotCapacity, label: title },
        });
        portfolioPubkey = pf.portfolio;
      }
      if (!portfolioPubkey) throw new Error("No account to withdraw from.");
      const params = {
        marketPubkey: market,
        portfolioPubkey,
        vaultPubkey: vault,
        quoteMint: QUOTE_MINT,
        amount: amountAtoms,
      };
      const r = isDeposit
        ? await depositFlow({ wallet, connection, params })
        : await withdrawFlow({ wallet, connection, params });
      setSig(r.signature);
      await balanceQ.refetch();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="panel glow-border w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display text-lg font-semibold">
              {isDeposit ? "Deposit" : "Withdraw"} {QUOTE_SYMBOL}
            </h3>
            <p className="text-[11px] text-muted-foreground">{title} · SPL vault custody</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="panel-flat rounded-md p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Amount</span>
            <span>
              {isDeposit ? "Wallet" : "Withdrawable"}:{" "}
              <span className="font-mono">${atomsToHuman(maxAtoms, undefined, true)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={running}
              placeholder="0"
              inputMode="decimal"
              className="bg-transparent flex-1 text-2xl font-mono focus:outline-none disabled:opacity-50"
            />
            <span className="text-sm font-mono text-muted-foreground">{QUOTE_SYMBOL}</span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              onClick={() => setPct(p)}
              disabled={running || maxAtoms === 0n}
              className="btn-ghost-border rounded-md py-2 text-xs disabled:opacity-50"
            >
              {p === 100 ? "MAX" : `${p}%`}
            </button>
          ))}
        </div>

        <div className="panel-flat rounded-md p-3 space-y-1.5 text-[11px] font-mono">
          <Line k="Vault" v={fmtPubkey(vault.toBase58(), 4, 4)} />
          <Line k="Network fee" v="~0.000005 SOL" />
          <Line
            k={isDeposit ? "New collateral" : "New withdrawable"}
            v={newCollateral !== null ? `$${atomsToHuman(newCollateral, undefined, true)}` : "-"}
          />
        </div>

        <button
          onClick={onSubmit}
          disabled={!valid || running}
          className="btn-primary w-full rounded-md py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isDeposit ? (
            <ArrowDownToLine className="h-4 w-4" />
          ) : (
            <ArrowUpFromLine className="h-4 w-4" />
          )}
          {running
            ? "Submitting…"
            : `${isDeposit ? "Deposit" : "Withdraw"} ${amount || "0"} ${QUOTE_SYMBOL}`}
        </button>

        {sig && (
          <div className="flex items-center gap-1 text-[11px] text-success">
            <Check className="h-3 w-3" />
            <a
              href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline inline-flex items-center gap-1"
            >
              {fmtPubkey(sig, 6, 6)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
        {error && <div className="text-[11px] text-danger break-words">{error}</div>}
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function OpenAccountCard({ onDone }: { onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const navigate = useNavigate();
  const marketsQ = useMarkets();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if ((marketsQ.data ?? []).length === 0) {
    return (
      <CenteredCard
        icon={<Rocket className="h-6 w-6 text-neon" />}
        title="No markets listed yet"
        body="List a pair on the shared group first, then open your cross-margin account."
        action={
          <button
            onClick={() => navigate({ to: "/launch" })}
            className="btn-primary inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
          >
            <Rocket className="h-4 w-4" /> Launch a market
          </button>
        }
      />
    );
  }

  const onOpen = async () => {
    setError(null);
    setRunning(true);
    try {
      await initPortfolioFlow({
        wallet,
        connection,
        params: {
          marketPubkey: SHARED_MARKET,
          assetSlotCapacity: SHARED_SLOT_CAPACITY,
          label: "cross-margin",
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <CenteredCard
      icon={<Wallet2 className="h-6 w-6 text-neon" />}
      title="Open your cross-margin account"
      body="One transaction. Deposit once afterwards and the collateral backs trades on every listed pair against the shared LP & Insurance Vault."
      action={
        <div className="space-y-2">
          <button
            onClick={onOpen}
            disabled={running}
            className="btn-primary inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wallet2 className="h-4 w-4" />
            )}
            {running ? "Opening…" : "Open account"}
          </button>
          {error && <div className="text-[11px] text-danger">{error}</div>}
        </div>
      }
    />
  );
}

function ConnectGate() {
  return (
    <CenteredCard
      icon={<Wallet className="h-6 w-6 text-neon" />}
      title="Connect a wallet"
      body="Your cross-margin account is scoped to your wallet. Connect Phantom or Solflare to deposit and trade."
      action={<WalletButton />}
    />
  );
}

function Kpi({
  label,
  value,
  accent,
  className,
}: {
  label: string;
  value: string;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={`panel p-4 ${accent ? "glow-border" : ""}`}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`font-mono text-2xl mt-1 ${className ?? ""}`}>{value}</div>
    </div>
  );
}

function KV({ k, v, cls, muted }: { k: string; v: string; cls?: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${muted ? "text-muted-foreground" : (cls ?? "")}`}>{v}</span>
    </div>
  );
}

function CenteredCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="px-4 py-12 flex items-center justify-center">
      <div className="max-w-md panel p-8 space-y-4 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-[oklch(0.86_0.16_188_/_0.10)] flex items-center justify-center">
          {icon}
        </div>
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="flex justify-center">{action}</div>
      </div>
    </div>
  );
}

function useWalletTokenBalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  return useQuery({
    queryKey: ["wallet-musdc", wallet.publicKey?.toBase58(), connection.rpcEndpoint],
    enabled: !!wallet.publicKey,
    queryFn: async () => {
      const ata = getAssociatedTokenAddressSync(QUOTE_MINT, wallet.publicKey!);
      try {
        return (await getAccount(connection, ata)).amount;
      } catch {
        return 0n;
      }
    },
    refetchInterval: 5_000,
  });
}

function useTokenBalance(connection: import("@solana/web3.js").Connection, pubkey: string) {
  return useQuery({
    queryKey: ["token-balance", pubkey, connection.rpcEndpoint],
    queryFn: async () => {
      try {
        return (await getAccount(connection, new PublicKey(pubkey))).amount;
      } catch {
        return 0n;
      }
    },
    refetchInterval: 5_000,
  });
}
