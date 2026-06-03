import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/openperps/WalletButton";
import { PublicKey } from "@solana/web3.js";
import {
  Activity,
  Check,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Wallet,
  Zap,
} from "lucide-react";

import { fmtPubkey } from "@/lib/format";
import { OraclePanel } from "@/components/openperps/OraclePanel";
import { useMarkets } from "@/lib/onchain";
import { listPortfoliosFor } from "@/lib/portfolioRegistry";
import { accrueAssetFlow, crankRefreshFlow, liquidateFlow } from "@/lib/flows/portfolioFlows";
import type { Market } from "@/lib/types";

export const Route = createFileRoute("/crank")({
  head: () => ({
    meta: [
      { title: "Keeper & Liquidations: OpenPerps" },
      {
        name: "description",
        content:
          "Permissionless keeper actions: refresh oracle / funding, recertify portfolios, attempt liquidations.",
      },
    ],
  }),
  component: Crank,
});

function Crank() {
  const wallet = useWallet();
  const marketsQ = useMarkets();
  const markets = marketsQ.data ?? [];

  if (!wallet.connected) return <ConnectGate />;
  if (markets.length === 0) return <NoMarketsGate />;

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto space-y-4">
      <header className="flex items-start gap-4">
        <div className="p-2.5 rounded-md panel-flat glow-border">
          <Zap className="h-5 w-5 text-neon" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Keeper actions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Run permissionless cranks (CrankRefresh, Liquidate) or authority-pinned oracle refreshes
            (AccrueAsset). Each form maps one-to-one onto an on-chain instruction.
          </p>
        </div>
      </header>

      <UnhealthyQueue />

      <div className="space-y-4">
        {markets.map((m) => (
          <MarketKeeperPanel key={m.pubkey} market={m} />
        ))}
      </div>
    </div>
  );
}

function ConnectGate() {
  return (
    <CenteredCard
      icon={<Wallet className="h-6 w-6 text-neon" />}
      title="Connect a wallet"
      body="Keeper actions need a signer. Connect Phantom or Solflare to crank, refresh, and liquidate."
      action={<WalletButton />}
    />
  );
}

function NoMarketsGate() {
  const navigate = useNavigate();
  return (
    <CenteredCard
      icon={<Rocket className="h-6 w-6 text-neon" />}
      title="No markets in your registry yet"
      body="Keeper actions target real markets. Launch one first, then come back to crank or liquidate."
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

function UnhealthyQueue() {
  return (
    <div className="panel p-4 flex items-start gap-3">
      <ShieldAlert className="h-4 w-4 text-violet shrink-0 mt-0.5" />
      <div className="text-xs space-y-1">
        <div className="font-medium text-foreground">Unhealthy account queue</div>
        <p className="text-muted-foreground">
          OpenPerps does not run an indexer yet, so we can't scan every portfolio system-wide for
          liquidation candidates. For now you point the form below at a specific portfolio
          (typically one you know is under water). The engine itself decides whether to progress; a
          healthy account responds with{" "}
          <code className="font-mono text-foreground">NonProgress</code>.
        </p>
      </div>
    </div>
  );
}

function MarketKeeperPanel({ market }: { market: Market }) {
  const wallet = useWallet();
  const owner = wallet.publicKey!.toBase58();
  const portfolios = listPortfoliosFor(owner, market.pubkey);

  return (
    <div className="panel p-5 space-y-4">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight">{market.symbol}</h2>
        <p className="text-[11px] font-mono text-muted-foreground">
          market <ExplorerLink kind="address" id={market.pubkey} />
        </p>
      </div>

      {market.oracleKind === "dex" && market.oraclePool && <OraclePanel market={market} />}

      <div className="grid lg:grid-cols-3 gap-3">
        <AccrueAssetForm market={market} />
        <CrankRefreshForm market={market} portfolios={portfolios} />
        <LiquidateForm market={market} portfolios={portfolios} />
      </div>
    </div>
  );
}

// ---------- AccrueAsset ----------

function AccrueAssetForm({ market }: { market: Market }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [assetIndex, setAssetIndex] = useState("0");
  const [price, setPrice] = useState("105000000");
  const [funding, setFunding] = useState("0");
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      const r = await accrueAssetFlow({
        wallet,
        connection,
        params: {
          marketPubkey: new PublicKey(market.pubkey),
          assetIndex: parseInt(assetIndex || "0", 10),
          effectivePrice: BigInt(price),
          fundingRateE9: BigInt(funding),
        },
      });
      setSig(r.signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <FormPanel
      title="AccrueAsset"
      tag="authority"
      Icon={RefreshCw}
      blurb="Push a fresh oracle price + funding rate for an asset slot. Authority-only."
      onSubmit={onSubmit}
      running={running}
      sig={sig}
      error={error}
      submitLabel="Refresh"
    >
      <Field label="Asset index">
        <NumInput value={assetIndex} onChange={setAssetIndex} disabled={running} />
      </Field>
      <Field label="Effective price (u64)">
        <NumInput value={price} onChange={setPrice} disabled={running} />
      </Field>
      <Field label="Funding rate (i128, e9)">
        <NumInput value={funding} onChange={setFunding} disabled={running} signed />
      </Field>
    </FormPanel>
  );
}

// ---------- CrankRefresh ----------

function CrankRefreshForm({
  market,
  portfolios,
}: {
  market: Market;
  portfolios: ReturnType<typeof listPortfoliosFor>;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [portfolio, setPortfolio] = useState<string | undefined>(portfolios[0]?.pubkey);
  const [assetIndex, setAssetIndex] = useState("0");
  const [price, setPrice] = useState("105000000");
  const [funding, setFunding] = useState("0");
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!portfolio) return;
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      const r = await crankRefreshFlow({
        wallet,
        connection,
        params: {
          marketPubkey: new PublicKey(market.pubkey),
          portfolioPubkey: new PublicKey(portfolio),
          assetIndex: parseInt(assetIndex || "0", 10),
          effectivePrice: BigInt(price),
          fundingRateE9: BigInt(funding),
        },
      });
      setSig(r.signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <FormPanel
      title="CrankRefresh"
      tag="permissionless"
      Icon={Activity}
      blurb="Re-certify a portfolio's health against fresh inputs. Anyone can call."
      onSubmit={onSubmit}
      running={running}
      sig={sig}
      error={error}
      submitLabel="Crank"
      disabled={!portfolio}
    >
      <PortfolioPicker portfolios={portfolios} value={portfolio} onChange={setPortfolio} />
      <Field label="Asset index">
        <NumInput value={assetIndex} onChange={setAssetIndex} disabled={running} />
      </Field>
      <Field label="Effective price (u64)">
        <NumInput value={price} onChange={setPrice} disabled={running} />
      </Field>
      <Field label="Funding rate (i128, e9)">
        <NumInput value={funding} onChange={setFunding} disabled={running} signed />
      </Field>
    </FormPanel>
  );
}

// ---------- Liquidate ----------

function LiquidateForm({
  market,
  portfolios,
}: {
  market: Market;
  portfolios: ReturnType<typeof listPortfoliosFor>;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [portfolio, setPortfolio] = useState<string | undefined>(portfolios[0]?.pubkey);
  const [assetIndex, setAssetIndex] = useState("0");
  const [closeQ, setCloseQ] = useState("1000000");
  // Group caps the per-trade fee at GROUP_MAX_FEE_BPS; higher reverts.
  const [feeBps, setFeeBps] = useState("10");
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!portfolio) return;
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      const r = await liquidateFlow({
        wallet,
        connection,
        params: {
          marketPubkey: new PublicKey(market.pubkey),
          portfolioPubkey: new PublicKey(portfolio),
          assetIndex: parseInt(assetIndex || "0", 10),
          closeQ: BigInt(closeQ),
          feeBps: BigInt(feeBps),
        },
      });
      setSig(r.signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <FormPanel
      title="Liquidate"
      tag="permissionless"
      Icon={ShieldAlert}
      blurb="Close up to close_q of an unhealthy portfolio's leg. Engine returns NonProgress on healthy accounts."
      onSubmit={onSubmit}
      running={running}
      sig={sig}
      error={error}
      submitLabel="Liquidate"
      disabled={!portfolio}
      submitClass="border border-danger/60 text-danger hover:bg-[oklch(0.66_0.24_18_/_0.10)]"
    >
      <PortfolioPicker portfolios={portfolios} value={portfolio} onChange={setPortfolio} />
      <Field label="Asset index">
        <NumInput value={assetIndex} onChange={setAssetIndex} disabled={running} />
      </Field>
      <Field label="Close q (u128)">
        <NumInput value={closeQ} onChange={setCloseQ} disabled={running} />
      </Field>
      <Field label="Fee (bps)">
        <NumInput value={feeBps} onChange={setFeeBps} disabled={running} />
      </Field>
    </FormPanel>
  );
}

// ---------- shared building blocks ----------

function FormPanel({
  title,
  tag,
  Icon,
  blurb,
  children,
  onSubmit,
  running,
  sig,
  error,
  submitLabel,
  submitClass,
  disabled,
}: {
  title: string;
  tag: "authority" | "permissionless";
  Icon: typeof Activity;
  blurb: string;
  children: React.ReactNode;
  onSubmit: () => void;
  running: boolean;
  sig: string | null;
  error: string | null;
  submitLabel: string;
  submitClass?: string;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-neon" />
          <div className="text-sm font-medium">{title}</div>
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${
            tag === "authority"
              ? "bg-[oklch(0.66_0.20_285_/_0.10)] text-violet"
              : "bg-[oklch(0.86_0.16_188_/_0.10)] text-neon"
          }`}
        >
          {tag}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{blurb}</p>
      <div className="space-y-2">{children}</div>
      <button
        onClick={onSubmit}
        disabled={running || disabled}
        className={`w-full rounded-md py-2 text-xs font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
          submitClass ?? "btn-primary"
        }`}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        {running ? `${submitLabel}ing…` : submitLabel}
      </button>
      {sig && (
        <div className="flex items-center gap-1 text-[11px] text-success">
          <Check className="h-3 w-3" />
          <ExplorerLink kind="tx" id={sig} />
        </div>
      )}
      {error && (
        <div className="text-[11px] text-danger inline-flex items-start gap-1">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function PortfolioPicker({
  portfolios,
  value,
  onChange,
}: {
  portfolios: ReturnType<typeof listPortfoliosFor>;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  if (portfolios.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground">
        No portfolios yet, open one on{" "}
        <Link to="/portfolio" className="text-neon underline">
          /portfolio
        </Link>{" "}
        first.
      </div>
    );
  }
  return (
    <div>
      <div className="text-[11px] text-muted-foreground mb-1">Portfolio</div>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-background/60 border border-border rounded-md px-2.5 py-2 text-xs font-mono focus:outline-none focus:border-neon/60"
      >
        {portfolios.map((p) => (
          <option key={p.pubkey} value={p.pubkey}>
            {fmtPubkey(p.pubkey, 8, 8)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground mb-1">{label}</div>
      <div className="bg-background/60 border border-border rounded-md px-2.5 py-1.5 focus-within:border-neon/60">
        {children}
      </div>
    </div>
  );
}

function NumInput({
  value,
  onChange,
  disabled,
  signed,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  signed?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (signed) {
          if (v === "" || /^-?\d*$/.test(v)) onChange(v);
        } else {
          if (v === "" || /^\d*$/.test(v)) onChange(v);
        }
      }}
      disabled={disabled}
      inputMode="numeric"
      className="bg-transparent w-full font-mono text-xs focus:outline-none disabled:opacity-50"
    />
  );
}

function ExplorerLink({ kind, id }: { kind: "address" | "tx"; id: string }) {
  return (
    <a
      href={`https://explorer.solana.com/${kind === "tx" ? "tx" : "address"}/${id}?cluster=devnet`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:text-neon"
    >
      {fmtPubkey(id, 6, 6)}
      <ExternalLink className="h-3 w-3" />
    </a>
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
