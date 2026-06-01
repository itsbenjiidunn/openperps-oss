/// House Vault overview, styled after the reference LP/insurance layout.
/// OpenPerps has one shared House Vault (the counterparty to every trade) +
/// one shared collateral vault. TVL and House capital/PnL are read live;
/// insurance / utilization / APR / fee-accrual are illustrative until an
/// indexer ships (labelled, not presented as settled numbers).

import { createFileRoute } from "@tanstack/react-router";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import { Vault as VaultIcon, ShieldCheck, TrendingUp, Activity, ExternalLink } from "lucide-react";

import { PriceChart } from "@/components/openperps/PriceChart";
import { usePortfolioState } from "@/lib/onchain";
import { atomsToHuman } from "@/lib/decimals";
import { QUOTE_SYMBOL } from "@/lib/collateral";
import { fmtPubkey } from "@/lib/format";
import { SHARED_HOUSE, SHARED_VAULT } from "@/lib/sharedMarket";

export const Route = createFileRoute("/vault")({
  head: () => ({
    meta: [
      { title: "LP & Insurance Vault — OpenPerps" },
      {
        name: "description",
        content:
          "The shared LP & Insurance Vault: counterparty to every trade, backed by quote-margined USDC.",
      },
    ],
  }),
  component: VaultPage,
});

const num = (s: string) => Number(s.replace(/,/g, "")) || 0;

function VaultPage() {
  const { connection } = useConnection();
  const tvlQ = useTokenBalance(connection, SHARED_VAULT.toBase58());
  const houseQ = usePortfolioState(SHARED_HOUSE.toBase58());

  const tvl = tvlQ.data !== undefined ? atomsToHuman(tvlQ.data, undefined, true) : "—";
  const houseCapital = houseQ.data ? atomsToHuman(houseQ.data.capital, undefined, true) : "—";
  const housePnl = houseQ.data
    ? `${houseQ.data.pnl >= 0n ? "+" : ""}${atomsToHuman(houseQ.data.pnl, undefined, true)}`
    : "—";
  const tvlNum = num(tvl);
  // Illustrative split (no indexer): treat 90% as LP, 10% as insurance buffer.
  const insurance = tvlNum * 0.1;
  const util = 0.18;

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto space-y-4">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-start gap-4">
          <div className="p-2.5 rounded-md panel-flat glow-border">
            <VaultIcon className="h-5 w-5 text-neon" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold">LP &amp; Insurance Vault</h1>
            <p className="text-sm text-muted-foreground">
              The shared counterparty to every trade. Quote-margined {QUOTE_SYMBOL}; earns the
              spread + taker fees, pays out trader profit.
            </p>
          </div>
        </div>
        <span className="text-[10px] px-2 py-1 rounded bg-violet/15 text-violet self-center">
          some metrics illustrative · no indexer
        </span>
      </header>

      <div className="grid md:grid-cols-4 gap-3">
        <Kpi
          label={`TVL (${QUOTE_SYMBOL})`}
          value={`$${tvl}`}
          accent
          icon={<TrendingUp className="h-4 w-4 text-neon" />}
        />
        <Kpi
          label="LP capital"
          value={`$${houseCapital}`}
          icon={<VaultIcon className="h-4 w-4 text-electric" />}
        />
        <Kpi
          label="LP PnL"
          value={`${housePnl}`}
          icon={<Activity className="h-4 w-4 text-violet" />}
        />
        <Kpi
          label="Insurance (illustrative)"
          value={`$${fmtNum(insurance)}`}
          icon={<ShieldCheck className="h-4 w-4 text-violet" />}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        <div className="panel p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm">
              TVL & utilization · 30D <span className="text-[10px] text-violet">illustrative</span>
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              vault <ExplorerLink id={SHARED_VAULT.toBase58()} /> · idle {fmtPct(1 - util)}
            </div>
          </div>
          <div className="h-[280px]">
            <PriceChart volume seed={4} color="var(--electric)" />
          </div>
        </div>

        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-3">
            Risk indicators
          </div>
          <div className="space-y-3">
            <Bar label="Solvency buffer" value={0.82} good />
            <Bar label="Utilization" value={util} />
            <Bar label="Liquidation surplus / wk" value={0.34} good />
            <Bar label="Worst-case 99% VaR" value={0.18} danger />
          </div>
          <div className="mt-4 p-3 panel-flat text-[11px] text-muted-foreground">
            The LP &amp; Insurance Vault absorbs the opposite side of every position. It is seeded
            once and shared across all pairs; trader PnL settles against it. Bars are illustrative
            pending an indexer.
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="panel p-4">
          <div className="text-sm mb-3">Vault composition</div>
          <ul className="space-y-2 text-xs">
            {[
              { k: "LP collateral (live)", v: num(houseCapital), c: "var(--neon)" },
              { k: "Insurance buffer (illustrative)", v: insurance, c: "var(--violet)" },
            ].map((s) => (
              <li key={s.k}>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{s.k}</span>
                  <span className="font-mono">${fmtNum(s.v)}</span>
                </div>
                <div className="h-1.5 mt-1 rounded-full bg-background/60 overflow-hidden border border-border">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${tvlNum > 0 ? Math.min(100, (s.v / tvlNum) * 100) : 0}%`,
                      background: s.c,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel p-4">
          <div className="text-sm mb-3">
            Recent fee accrual <span className="text-[10px] text-violet">illustrative</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-muted-foreground">
                <th className="text-left py-1.5 font-normal">Epoch</th>
                <th className="text-left font-normal">Market</th>
                <th className="text-right font-normal">Fees</th>
                <th className="text-right font-normal">To LP</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["#48211", "SOL-PERP", 18420, 18420],
                ["#48210", "JUP-PERP", 4214, 4214],
                ["#48209", "BONK-PERP", 6182, 6182],
              ].map(([e, m, f, h]) => (
                <tr key={e as string} className="border-t border-border/30">
                  <td className="py-1.5 font-mono text-muted-foreground">{e}</td>
                  <td>{m}</td>
                  <td className="text-right font-mono">${fmtNum(f as number)}</td>
                  <td className="text-right font-mono text-success">${fmtNum(h as number)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Fee history needs an indexer; rows above are sample data.
          </p>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground font-mono">
        LP vault portfolio <ExplorerLink id={SHARED_HOUSE.toBase58()} />
      </div>
    </div>
  );
}

function ExplorerLink({ id }: { id: string }) {
  return (
    <a
      href={`https://explorer.solana.com/address/${id}?cluster=devnet`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:text-neon"
    >
      {fmtPubkey(id, 4, 4)}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function Kpi({
  label,
  value,
  className,
  accent,
  icon,
}: {
  label: string;
  value: string;
  className?: string;
  accent?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`panel p-4 ${accent ? "glow-border" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        {icon}
      </div>
      <div className={`font-mono text-2xl mt-1 ${className ?? ""}`}>{value}</div>
    </div>
  );
}

function Bar({
  label,
  value,
  good,
  danger,
}: {
  label: string;
  value: number;
  good?: boolean;
  danger?: boolean;
}) {
  const color = danger ? "var(--danger)" : good ? "var(--success)" : "var(--neon)";
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-background/60 border border-border overflow-hidden">
        <div
          className="h-full"
          style={{
            width: `${value * 100}%`,
            background: color,
            boxShadow: `0 0 10px -2px ${color}`,
          }}
        />
      </div>
    </div>
  );
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
