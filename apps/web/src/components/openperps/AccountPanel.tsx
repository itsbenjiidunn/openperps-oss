/// Account panel for the selected market. Styled like a cross-margin account
/// but, until the single-group restructure, it reflects this market's own
/// portfolio (capital + PnL). Deposit / Withdraw route to the Portfolio page.

import { useWallet } from "@solana/wallet-adapter-react";
import { Link } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, Wallet } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { fmtPubkey } from "@/lib/format";
import { useMarkets, usePortfolioPositions, usePortfolioState } from "@/lib/onchain";
import { useLivePrices, normalizeFeedId } from "@/lib/livePrice";
import { fetchPositionEntries, entryKey } from "@/lib/indexer";
import { SHARED_MARKET } from "@/lib/sharedMarket";
import { userPortfolio } from "@/lib/program";
import { atomsToHuman } from "@/lib/decimals";
import { QUOTE_SYMBOL } from "@/lib/collateral";
import type { Market } from "@/lib/types";

export function AccountPanel({ market }: { market: Market }) {
  const wallet = useWallet();

  if (!wallet.connected) {
    return (
      <div className="panel p-3 text-xs text-muted-foreground">
        Connect a wallet to view account state.
      </div>
    );
  }

  const owner = wallet.publicKey!.toBase58();
  // Deterministic PDA for (owner, market) — same address on any device.
  const portfolio = userPortfolio(owner, market.pubkey);

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground">{market.symbol} account</div>
          <div className="font-mono text-xs truncate">{fmtPubkey(portfolio, 6, 6)}</div>
        </div>
        <Wallet className="h-4 w-4 text-neon shrink-0" />
      </div>

      <AccountBody portfolio={portfolio} owner={owner} market={market} />

      <div className="grid grid-cols-2 gap-2">
        <Link
          to="/portfolio"
          className="btn-ghost-border rounded-md py-2 text-xs flex items-center justify-center gap-1.5"
        >
          <ArrowDownToLine className="h-3.5 w-3.5" /> Deposit
        </Link>
        <Link
          to="/portfolio"
          className="btn-ghost-border rounded-md py-2 text-xs flex items-center justify-center gap-1.5"
        >
          <ArrowUpFromLine className="h-3.5 w-3.5" /> Withdraw
        </Link>
      </div>
    </div>
  );
}

function AccountBody({
  portfolio,
  owner,
  market,
}: {
  portfolio: string;
  owner: string;
  market: Market;
}) {
  const stateQ = usePortfolioState(portfolio);
  const posQ = usePortfolioPositions(portfolio);
  const marketsQ = useMarkets();
  const entriesQ = useQuery({
    queryKey: ["pos-entries", owner],
    enabled: !!owner,
    queryFn: () => fetchPositionEntries(owner),
    refetchInterval: 15_000,
  });

  const positions = posQ.data ?? [];
  // Majors-only: custom own-group markets share slot 0 with SOL and must not
  // shadow it when resolving a shared-group leg by slot.
  const bySlot = new Map(
    (marketsQ.data ?? []).filter((m) => !m.ownGroup).map((m) => [m.assetIndex, m]),
  );
  // This panel is one market's portfolio. A custom isolated group holds only
  // this market (its slot 0 must NOT be resolved against the majors table,
  // where slot 0 is a different coin); the shared group resolves each leg by
  // slot. `marketOf` picks the right market for a leg.
  const isCustom = !!market.ownGroup;
  const groupMarket = isCustom ? market.pubkey : SHARED_MARKET.toBase58();
  const marketOf = (p: { assetIndex: number }) => (isCustom ? market : bySlot.get(p.assetIndex));
  // Stream live marks for every market this account has a position in.
  const livePrices = useLivePrices(positions.map((p) => marketOf(p)?.oracleFeedId));

  // Unrealized PnL = Σ (live mark − VWAP entry) × size × side, marked to the
  // continuous Pyth price (not the on-chain realized-PnL field, which only
  // moves on settlement). Null until entries load.
  let unrealized: number | null = entriesQ.data ? 0 : null;
  // Initial margin locked by open positions = Σ notional / leverage. Drives the
  // "Available" figure so opening a position visibly uses up the account's
  // buying power (cross-margin: collateral isn't spent, it's reserved).
  let usedMargin = 0;
  for (const p of positions) {
    const mk = marketOf(p);
    if (!mk) continue;
    const live = (mk.oracleFeedId && livePrices.get(normalizeFeedId(mk.oracleFeedId))) || mk.price;
    if (live <= 0) continue;
    const size = Number(p.sizeQ) / 1_000_000;
    usedMargin += (live * size) / (mk.maxLeverage ?? 20);
    if (entriesQ.data) {
      const entry = entriesQ.data.get(entryKey(groupMarket, p.assetIndex))?.entry;
      if (entry != null) {
        unrealized = (unrealized ?? 0) + (live - entry) * size * (p.side === 0 ? 1 : -1);
      }
    }
  }
  // One simple balance = capital + realized PnL. Percolator parks realized
  // profit in a separate `pnl` ledger; we fold it into the displayed Balance so
  // closing a winning trade visibly raises it. The Withdraw flow runs SettlePnl
  // first (the House pays it into `capital`), so this whole Balance is what you
  // can actually withdraw — like a normal isolated-margin perp.
  const capital = stateQ.data?.capital;
  const realized = stateQ.data?.pnl ?? 0n;
  const equity = capital !== undefined ? capital + realized : undefined;
  // Free buying power = (equity + open PnL) − margin locked by positions. Drops
  // when you open, frees up when you close.
  const availableUsd =
    equity !== undefined
      ? Math.max(0, Number(equity) / 1_000_000 + (unrealized ?? 0) - usedMargin)
      : undefined;
  const uPos = (unrealized ?? 0) >= 0;

  // The PDA is derivable before the account is initialized; `null` state means
  // it doesn't exist on-chain yet → prompt the user to open + fund it. Placed
  // AFTER all hooks so hook order never changes (React error #300).
  if (stateQ.data === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No account on this market yet.{" "}
        <Link to="/portfolio" className="text-neon underline">
          Open one
        </Link>{" "}
        and deposit collateral to trade.
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {/* Balance = Available: the usable balance. Opening a position moves
            margin out of it; closing returns the margin plus realized PnL. When
            flat it equals full account equity (capital + realized PnL). */}
        <Stat
          label="Balance"
          value={
            availableUsd !== undefined
              ? `${availableUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${QUOTE_SYMBOL}`
              : "—"
          }
          accent
        />
        <Stat
          label="Available"
          value={
            availableUsd !== undefined
              ? `${availableUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${QUOTE_SYMBOL}`
              : "—"
          }
        />
        <Stat
          label="Unrealized PnL"
          value={
            unrealized === null
              ? "—"
              : `${uPos ? "+" : ""}${unrealized.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${QUOTE_SYMBOL}`
          }
          className={unrealized === null ? "" : uPos ? "text-success" : "text-danger"}
        />
        <Stat
          label="Margin used"
          value={`${usedMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${QUOTE_SYMBOL}`}
        />
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <a
          href={`https://explorer.solana.com/address/${portfolio}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-muted-foreground hover:text-neon inline-flex items-center gap-1"
        >
          {fmtPubkey(portfolio, 4, 4)}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </>
  );
}

function Stat({
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
    <div className={`panel-flat px-2.5 py-2 rounded-md ${accent ? "border-neon/40" : ""}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm mt-0.5 ${className ?? ""}`}>{value}</div>
    </div>
  );
}
