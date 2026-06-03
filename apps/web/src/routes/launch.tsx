import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/openperps/WalletButton";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Droplets,
  ExternalLink,
  Loader2,
  Power,
  Radio,
  RefreshCw,
  Rocket,
  Vault,
} from "lucide-react";

import {
  launchMarket,
  type LaunchProgress,
  type LaunchResult,
  type LaunchStepName,
} from "@/lib/flows/launchMarket";
import {
  ASSET_PRESETS,
  RISK_TIERS,
  defaultTierFor,
  priceUsdToAtoms,
  type AssetPreset,
  type OracleKind,
  type RiskTier,
} from "@/lib/assets";
import { fetchAssetPrice, fetchTokenInfo } from "@/lib/priceFeed";
import { useDexStats } from "@/lib/dexscreener";
import { GROUP_MAX_FEE_BPS } from "@/lib/sharedMarket";
import { QUOTE_MINT, QUOTE_SYMBOL } from "@/lib/collateral";
import { QUOTE_DECIMALS, atomsToHuman, humanToAtoms } from "@/lib/decimals";
import { fmtPubkey } from "@/lib/format";

export const Route = createFileRoute("/launch")({
  head: () => ({
    meta: [
      { title: "Launch Market: OpenPerps" },
      {
        name: "description",
        content:
          "Launch a permissionless perp market for an existing asset (SOL, BTC, ETH, BONK, JUP, or any SPL mint) against shared USDC collateral.",
      },
    ],
  }),
  component: Launch,
});

const STEP_LABELS = ["Asset", "Oracle", "Risk tier", "Review"] as const;

/// A custom SPL market is its OWN isolated group: create the group, seed its
/// House from your wallet, (DEX) create the pool, then activate slot 0.
const CUSTOM_CAPACITY = 4;

function txOrderFor(oracleKind: OracleKind): LaunchStepName[] {
  return oracleKind === "dex"
    ? ["init-group", "seed-house", "create-pool", "activate"]
    : ["init-group", "seed-house", "activate"];
}

const TX_META: Record<LaunchStepName, { label: string; hint: string }> = {
  "init-group": {
    label: "Create market group",
    hint: "InitMarket, a fresh isolated group (own vault + House), separate from the majors pool.",
  },
  "seed-house": {
    label: "Seed House (LP + insurance)",
    hint: "CreateVault + CreateHouseVault + FundHouseVault, deposits your mUSDC as the market's backing.",
  },
  "create-pool": {
    label: "Create + seed DEX pool",
    hint: "A mock constant-product pool seeded at your price, the on-chain DEX-EWMA price source.",
  },
  activate: {
    label: "Activate the market",
    hint: "ActivateMarket(slot 0) at the seed price (+ pin the pool for DEX).",
  },
};

type WizardState = {
  step: number;
  presetTicker: string; // ticker or "CUSTOM"
  customTicker: string;
  customMint: string;
  oracleKind: OracleKind;
  manualPriceUsd: string;
  tierId: string;
  feeBps: string;
  /// mUSDC the creator seeds into the new group's House (LP + insurance).
  seedLp: string;
};

const DEFAULT_STATE: WizardState = {
  step: 0,
  // The majors (SOL/BTC/ETH/JUP) are built-in official markets; the launcher
  // is only for listing a custom SPL token.
  presetTicker: "CUSTOM",
  customTicker: "",
  customMint: "",
  oracleKind: "dex",
  manualPriceUsd: "",
  tierId: defaultTierFor(null).id,
  feeBps: "5",
  seedLp: "1000",
};

const MIN_SEED_LP = 100;
/// Floor on the underlying token's DEX-pool liquidity (USD) before we let a
/// memecoin perp market be created. Below this, the pool is cheap to move with a
/// flash loan → the mark can be manipulated. Tune up for mainnet.
const MIN_POOL_LIQUIDITY_USD = 25_000;

function Launch() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const navigate = useNavigate();
  const [s, setS] = useState<WizardState>(DEFAULT_STATE);
  const [progress, setProgress] = useState<
    Partial<Record<LaunchStepName, { signature?: string; running?: boolean }>>
  >({});
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [priceSource, setPriceSource] = useState<"pyth" | "jupiter" | "preset" | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  // Token ticker/name auto-resolved from a pasted mint (Jupiter registry).
  const [detected, setDetected] = useState<{ symbol: string; name: string } | null>(null);
  // The mint whose ticker we already auto-filled, so manual edits aren't clobbered.
  const autoTickerRef = useRef<string>("");

  // ---- derive the chosen asset (preset or custom) ----
  const preset: AssetPreset | null = useMemo(() => {
    if (s.presetTicker === "CUSTOM") return null;
    return ASSET_PRESETS.find((a) => a.ticker === s.presetTicker) ?? null;
  }, [s.presetTicker]);

  const customMintValid = useMemo(() => {
    if (!s.customMint.trim()) return false;
    try {
      new PublicKey(s.customMint.trim());
      return true;
    } catch {
      return false;
    }
  }, [s.customMint]);

  const asset = useMemo<DerivedAsset | null>(() => {
    if (preset) {
      return {
        ticker: preset.ticker,
        symbol: preset.symbol,
        name: preset.name,
        baseMint: preset.baseMint,
        pythFeedId: preset.pythFeedId,
        defaultPriceUsd: preset.defaultPriceUsd,
        synthetic: preset.synthetic,
      };
    }
    const t = s.customTicker.trim().toUpperCase();
    if (!t) return null;
    return {
      ticker: t,
      symbol: `${t}-PERP`,
      name: `${t} (custom)`,
      baseMint: customMintValid ? s.customMint.trim() : undefined,
      pythFeedId: undefined,
      defaultPriceUsd: 1,
      synthetic: !customMintValid,
    };
  }, [preset, s.customTicker, s.customMint, customMintValid]);

  const tier: RiskTier = useMemo(
    () => RISK_TIERS.find((t) => t.id === s.tierId) ?? RISK_TIERS[2]!,
    [s.tierId],
  );

  // Creator's mUSDC balance, the seed must come from it (faucet on devnet).
  const owner = wallet.publicKey?.toBase58() ?? "";
  const balanceQ = useQuery({
    queryKey: ["musdc-bal", owner, connection.rpcEndpoint],
    enabled: !!owner,
    refetchInterval: 15_000,
    queryFn: async () => {
      try {
        const ata = getAssociatedTokenAddressSync(QUOTE_MINT, wallet.publicKey!);
        const acc = await getAccount(connection, ata);
        return Number(acc.amount) / 10 ** QUOTE_DECIMALS;
      } catch {
        return 0;
      }
    },
  });
  const walletMusdc = balanceQ.data ?? 0;
  const seedLpNum = Number(s.seedLp) || 0;
  const seedValid = seedLpNum >= MIN_SEED_LP && seedLpNum <= walletMusdc;

  // DEX (mock pool) and Manual are both available for any asset on devnet.
  const effectiveOracleKind: OracleKind = s.oracleKind === "dex" ? "dex" : "manual";

  const seedPriceUsd = useMemo(() => {
    if (s.manualPriceUsd.trim()) {
      const n = Number(s.manualPriceUsd);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    // A DEX-backed custom market (real mint) MUST seed at the token's real live
    // price: after launch the keeper converges the on-chain mark to that price,
    // so a wrong seed (the old $1 default) craters the mark and liquidates
    // anyone who traded at the seed. Require a resolved/typed price, never fall
    // back to a placeholder default for these.
    if (effectiveOracleKind === "dex" && customMintValid) return null;
    return asset?.defaultPriceUsd ?? null;
  }, [s.manualPriceUsd, asset, effectiveOracleKind, customMintValid]);

  // Min-liquidity gate: a DEX-priced memecoin market is only as safe as its
  // pool is deep. Thin pools are flash-loan-manipulable (the #1 oracle attack
  // on a memecoin perp), so refuse to list a market whose pool is below the
  // floor. (Interim app-level guard; the on-chain enforcement, size caps vs
  // pool depth at trade time, is the next production-hardening item.)
  const dexStatsQ = useDexStats(customMintValid ? s.customMint.trim() : undefined);
  const poolLiquidity = dexStatsQ.data?.liquidityUsd ?? null;
  const needsLiquidityGate = effectiveOracleKind === "dex" && customMintValid;
  const liquidityOk =
    !needsLiquidityGate || (poolLiquidity != null && poolLiquidity >= MIN_POOL_LIQUIDITY_USD);

  // ---- auto-fetch ticker + live spot price when the mint / asset changes ----
  const presetTicker = s.presetTicker;
  const customMint = customMintValid ? s.customMint.trim() : "";
  const loadPrice = useMemo(
    () => async () => {
      // Majors: price only (ticker is fixed by the preset).
      if (preset) {
        setPriceLoading(true);
        try {
          const r = await fetchAssetPrice({
            pythFeedId: preset.pythFeedId,
            baseMint: preset.baseMint,
          });
          if (r) {
            setS((prev) => ({ ...prev, manualPriceUsd: String(r.price) }));
            setPriceSource(r.source);
          } else {
            setPriceSource("preset");
          }
        } finally {
          setPriceLoading(false);
        }
        return;
      }
      // Custom SPL: paste a mint → resolve its ticker + name + live price in one
      // shot, so the launcher doesn't make you type either.
      if (!customMint) {
        setDetected(null);
        setPriceSource(null);
        return;
      }
      setPriceLoading(true);
      try {
        const info = await fetchTokenInfo(customMint);
        setDetected(info.symbol ? { symbol: info.symbol, name: info.name ?? info.symbol } : null);
        setS((prev) => {
          const next = { ...prev };
          // Auto-fill the ticker once per mint; respect later manual edits.
          if (info.symbol && autoTickerRef.current !== customMint) {
            autoTickerRef.current = customMint;
            next.customTicker = info.symbol.toUpperCase();
          }
          if (info.price !== undefined) next.manualPriceUsd = String(info.price);
          return next;
        });
        setPriceSource(info.price !== undefined ? "jupiter" : "preset");
      } finally {
        setPriceLoading(false);
      }
    },
    [preset, customMint],
  );

  useEffect(() => {
    let cancelled = false;
    setPriceSource(null);
    void loadPrice().catch(() => {
      if (!cancelled) setPriceSource("preset");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetTicker, customMint]);

  // ---- per-step validity ----
  const stepValid = (step: number): boolean => {
    switch (step) {
      case 0:
        return !!asset;
      case 1:
        return seedPriceUsd !== null && liquidityOk;
      case 2:
        return !!tier && seedValid;
      case 3:
        return wallet.connected && seedPriceUsd !== null && seedValid && liquidityOk;
      default:
        return false;
    }
  };

  const go = (delta: number) =>
    setS((prev) => ({
      ...prev,
      step: Math.min(STEP_LABELS.length - 1, Math.max(0, prev.step + delta)),
    }));

  const onLaunch = async () => {
    if (!asset || seedPriceUsd === null) return;
    setError(null);
    setResult(null);
    setProgress({});
    setRunning(true);
    try {
      const r = await launchMarket({
        wallet,
        connection,
        params: {
          symbol: asset.symbol,
          base: asset.ticker,
          baseMint: asset.baseMint,
          oracleKind: effectiveOracleKind,
          maxLeverage: tier.maxLeverage,
          // The group caps the per-trade fee at GROUP_MAX_FEE_BPS;
          // advertising more would make every trade revert as InvalidConfig.
          feeBps: Math.max(1, Math.min(GROUP_MAX_FEE_BPS, parseInt(s.feeBps || "5", 10) || 5)),
          seedPriceUsd,
          initialPrice: priceUsdToAtoms(seedPriceUsd, QUOTE_DECIMALS),
          // Seed the new group's House with the creator's mUSDC (LP + insurance).
          seedLpAtoms: BigInt(Math.round((Number(s.seedLp) || 0) * 10 ** QUOTE_DECIMALS)),
          assetSlotCapacity: CUSTOM_CAPACITY,
        },
        onProgress: (p: LaunchProgress) => {
          setProgress((prev) => ({
            ...prev,
            [p.step]: { signature: p.signature, running: !p.signature },
          }));
        },
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-4xl mx-auto">
      <header className="mb-6 flex items-start gap-4">
        <div className="p-2.5 rounded-md panel-flat glow-border">
          <Rocket className="h-5 w-5 text-neon" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            List a custom SPL market
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            The majors (<span className="text-foreground">SOL, BTC, ETH, JUP</span>) are already
            live. Use this to list <span className="text-foreground">any other SPL token</span> as a
            perp in its <span className="text-foreground">own isolated market</span>: you create the
            group and seed its House (LP) with your {QUOTE_SYMBOL}. Risk stays contained to that
            seed.
          </p>
        </div>
      </header>

      {result ? (
        <SuccessPanel
          result={result}
          symbol={asset?.symbol ?? "market"}
          onGoTerminal={() => navigate({ to: "/app" })}
        />
      ) : (
        <div className="grid lg:grid-cols-[240px_1fr] gap-4">
          <StepSidebar
            current={s.step}
            valid={stepValid}
            onGo={(i) => setS((p) => ({ ...p, step: i }))}
          />
          <div className="space-y-4">
            <div className="panel p-5 space-y-4">
              {s.step === 0 && (
                <AssetStep
                  customTicker={s.customTicker}
                  customMint={s.customMint}
                  customMintValid={customMintValid}
                  detected={detected}
                  detecting={priceLoading}
                  onCustomTicker={(v) => setS({ ...s, customTicker: v })}
                  onCustomMint={(v) => setS({ ...s, customMint: v })}
                />
              )}
              {s.step === 1 && asset && (
                <OracleStep
                  asset={asset}
                  oracleKind={effectiveOracleKind}
                  manualPriceUsd={s.manualPriceUsd}
                  onKind={(k) => setS({ ...s, oracleKind: k })}
                  onManualPrice={(v) => setS({ ...s, manualPriceUsd: v })}
                  priceSource={priceSource}
                  priceLoading={priceLoading}
                  onRefreshPrice={() => void loadPrice()}
                />
              )}
              {s.step === 2 && (
                <RiskStep
                  tierId={s.tierId}
                  onPick={(id) => setS({ ...s, tierId: id })}
                  feeBps={s.feeBps}
                  onFee={(v) => setS({ ...s, feeBps: v })}
                  seedLp={s.seedLp}
                  onSeed={(v) => setS({ ...s, seedLp: v })}
                  walletMusdc={walletMusdc}
                  seedValid={seedValid}
                />
              )}
              {s.step === 3 && asset && (
                <ReviewStep
                  asset={asset}
                  oracleKind={effectiveOracleKind}
                  tier={tier}
                  seedPriceUsd={seedPriceUsd}
                  feeBps={s.feeBps}
                  seedLp={s.seedLp}
                />
              )}

              {needsLiquidityGate && !liquidityOk && (
                <div className="mt-3 rounded-md border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[11px] text-danger">
                  {poolLiquidity == null
                    ? "Checking pool liquidity…"
                    : `Pool liquidity too low ($${poolLiquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}). Minimum $${MIN_POOL_LIQUIDITY_USD.toLocaleString()}, a thin pool can be flash-loan-manipulated, so this market is blocked.`}
                </div>
              )}

              <div className="flex items-center justify-between pt-3 border-t border-border/60">
                <button
                  onClick={() => go(-1)}
                  disabled={s.step === 0 || running}
                  className="btn-ghost-border rounded-md px-3 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
                {s.step < STEP_LABELS.length - 1 ? (
                  <button
                    onClick={() => go(1)}
                    disabled={!stepValid(s.step)}
                    className="btn-primary rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={onLaunch}
                    disabled={!stepValid(3) || running}
                    className="btn-primary rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    {running ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                    {running ? "Launching…" : "Launch market"}
                  </button>
                )}
              </div>

              {error && (
                <div className="panel-flat border border-danger/50 p-3 text-xs text-danger">
                  {error}
                </div>
              )}
            </div>

            <div className="space-y-4">
              {!wallet.connected && (
                <div className="panel p-4 flex flex-col gap-3">
                  <p className="text-sm font-medium">Connect to launch</p>
                  <p className="text-[11px] text-muted-foreground">
                    Launching is 3–4 signatures (group rent ~0.05 SOL + your {QUOTE_SYMBOL} seed).
                    You're the market's authority and can withdraw unused House LP later.
                  </p>
                  <WalletButton />
                </div>
              )}
              {running || Object.keys(progress).length > 0 ? (
                <ProgressPanel progress={progress} order={txOrderFor(effectiveOracleKind)} />
              ) : (
                <SummaryAside
                  asset={asset}
                  oracleKind={effectiveOracleKind}
                  tier={tier}
                  seedPriceUsd={seedPriceUsd}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- derived asset type ----------

type DerivedAsset = {
  ticker: string;
  symbol: string;
  name: string;
  baseMint?: string;
  pythFeedId?: string;
  defaultPriceUsd: number;
  synthetic: boolean;
};

// ---------- step sidebar ----------

const STEP_HINTS = [
  "Pick the underlying",
  "Price source",
  "Leverage & taker fee",
  "Confirm & launch",
] as const;

function StepSidebar({
  current,
  valid,
  onGo,
}: {
  current: number;
  valid: (n: number) => boolean;
  onGo: (i: number) => void;
}) {
  return (
    <ol className="panel p-2 h-fit">
      {STEP_LABELS.map((label, i) => {
        const done = i < current && valid(i);
        const active = i === current;
        // Allow jumping back, or forward only if prior steps validate.
        const reachable = i <= current || valid(i - 1);
        return (
          <li key={label}>
            <button
              onClick={() => reachable && onGo(i)}
              disabled={!reachable}
              className={`w-full text-left flex gap-3 items-start p-2.5 rounded-md transition-colors ${
                active
                  ? "bg-[oklch(0.86_0.16_188_/_0.08)]"
                  : "hover:bg-white/[0.02] disabled:hover:bg-transparent"
              } disabled:opacity-40`}
            >
              <span
                className={`mt-0.5 h-7 w-7 rounded-md flex items-center justify-center text-xs font-medium border shrink-0 ${
                  done
                    ? "border-success text-success"
                    : active
                      ? "border-neon text-neon"
                      : "border-border text-muted-foreground"
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="flex-1">
                <span className="block text-[11px] text-muted-foreground">Step {i + 1}</span>
                <span className={`block text-sm ${active ? "text-neon" : ""}`}>{label}</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  {STEP_HINTS[i]}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Step 1: Asset ----------

function AssetStep({
  customTicker,
  customMint,
  customMintValid,
  detected,
  detecting,
  onCustomTicker,
  onCustomMint,
}: {
  customTicker: string;
  customMint: string;
  customMintValid: boolean;
  detected: { symbol: string; name: string } | null;
  detecting: boolean;
  onCustomTicker: (v: string) => void;
  onCustomMint: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <StepHeader n={1} title="Custom SPL token" />
      <p className="text-xs text-muted-foreground">
        SOL, BTC, ETH and JUP are already listed with live prices, no need to launch them. This
        wizard lists any <span className="text-foreground">other SPL token</span> as a perp. Paste
        its mint and we auto-fill the ticker and price.
      </p>

      <div className="space-y-3 pt-1">
        <Field
          label="SPL mint address (contract address)"
          hint="Paste the token's CA. If Jupiter knows it, the ticker and live price fill in automatically."
        >
          <Input
            value={customMint}
            onChange={(e) => onCustomMint(e.target.value)}
            placeholder="Token mint address"
          />
        </Field>

        {customMint.trim() && !customMintValid && (
          <div className="text-[11px] text-danger">Not a valid base58 pubkey.</div>
        )}

        {customMintValid && detecting && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> resolving token…
          </div>
        )}

        {customMintValid && !detecting && detected && (
          <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/[0.06] px-3 py-2">
            <Check className="h-3.5 w-3.5 text-success shrink-0" />
            <span className="text-xs">
              Detected <span className="font-medium">{detected.symbol}</span>
              <span className="text-muted-foreground"> · {detected.name}</span>
            </span>
          </div>
        )}

        {customMintValid && !detecting && !detected && (
          <div className="text-[11px] text-muted-foreground">
            Not in Jupiter's registry. Enter the ticker and seed price manually below.
          </div>
        )}

        <Field
          label="Ticker"
          hint={detected ? "Auto-filled from the mint. Edit if you want." : "Shown as TICKER-PERP."}
        >
          <Input
            value={customTicker}
            onChange={(e) => onCustomTicker(e.target.value)}
            placeholder="e.g. WIF"
          />
        </Field>
      </div>
    </div>
  );
}

// ---------- Step 2: Oracle ----------

function OracleStep({
  asset,
  oracleKind,
  manualPriceUsd,
  onKind,
  onManualPrice,
  priceSource,
  priceLoading,
  onRefreshPrice,
}: {
  asset: DerivedAsset;
  oracleKind: OracleKind;
  manualPriceUsd: string;
  onKind: (k: OracleKind) => void;
  onManualPrice: (v: string) => void;
  priceSource: "pyth" | "jupiter" | "preset" | null;
  priceLoading: boolean;
  onRefreshPrice: () => void;
}) {
  return (
    <div className="space-y-4">
      <StepHeader n={2} title="Oracle price feed" />
      <p className="text-xs text-muted-foreground">
        Perps are priced off an oracle, not an order book. Pick the price source for{" "}
        <span className="font-mono">{asset.symbol}</span>.
      </p>

      <button
        onClick={() => onKind("dex")}
        className={`w-full text-left rounded-md border p-3 transition-colors ${
          oracleKind === "dex"
            ? "border-neon bg-[oklch(0.86_0.16_188_/_0.06)]"
            : "border-border hover:border-neon/50"
        }`}
      >
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-neon" />
          <span className="font-medium">DEX pool (EWMA)</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-electric/15 text-electric">
            recommended
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          A mock constant-product pool is created and pinned at the seed price below. The mark is
          its on-chain EWMA, anyone can crank, no keeper. With a real pool this is a Raydium /
          pumpswap pair.
        </div>
      </button>

      <button
        onClick={() => onKind("manual")}
        className={`w-full text-left rounded-md border p-3 transition-colors ${
          oracleKind === "manual"
            ? "border-neon bg-[oklch(0.86_0.16_188_/_0.06)]"
            : "border-border hover:border-neon/50"
        }`}
      >
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-violet" />
          <span className="font-medium">Manual / simulated pool</span>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          No pool, you set the price and refresh it via AccrueAsset on the Advanced page. Simplest,
          least realistic.
        </div>
      </button>

      <Field
        label="Seed price (USD)"
        hint={
          oracleKind === "dex"
            ? `Seeds the pool's reserves so spot starts here. Defaults to ~$${asset.defaultPriceUsd}.`
            : `Activates slot 0. Defaults to the preset ~$${asset.defaultPriceUsd}.`
        }
      >
        <Input
          value={manualPriceUsd}
          onChange={(e) => onManualPrice(e.target.value)}
          placeholder={String(asset.defaultPriceUsd)}
          inputMode="decimal"
        />
      </Field>

      <div className="flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          {priceLoading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">fetching live price…</span>
            </>
          ) : priceSource === "pyth" || priceSource === "jupiter" ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              <span className="text-success">
                live price · {priceSource === "pyth" ? "Pyth" : "Jupiter"}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              preset estimate (no live feed for this asset)
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onRefreshPrice}
          disabled={priceLoading}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>
    </div>
  );
}

// ---------- Step 3: Risk tier ----------

function RiskStep({
  tierId,
  onPick,
  feeBps,
  onFee,
  seedLp,
  onSeed,
  walletMusdc,
  seedValid,
}: {
  tierId: string;
  onPick: (id: string) => void;
  feeBps: string;
  onFee: (v: string) => void;
  seedLp: string;
  onSeed: (v: string) => void;
  walletMusdc: number;
  seedValid: boolean;
}) {
  const feePct = (() => {
    const n = parseInt(feeBps || "0", 10);
    return Number.isFinite(n) ? (n / 100).toFixed(2) : "-";
  })();
  const seedNum = Number(seedLp) || 0;
  return (
    <div className="space-y-4">
      <StepHeader n={3} title="Margin, fee & liquidity" />
      <p className="text-xs text-muted-foreground">
        Max leverage sets the trader's cap; the taker fee accrues to this market's House. You seed
        that House with your own {QUOTE_SYMBOL}, it's the LP + insurance that backs every trade on
        this isolated market.
      </p>
      <div className="space-y-2">
        {RISK_TIERS.map((t) => (
          <button
            key={t.id}
            onClick={() => onPick(t.id)}
            className={`w-full text-left rounded-md border p-3 transition-colors ${
              tierId === t.id
                ? "border-neon bg-[oklch(0.86_0.16_188_/_0.06)]"
                : "border-border hover:border-neon/50"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{t.label}</span>
              <span className="font-mono text-sm text-neon">{t.maxLeverage}× max</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t.blurb}</div>
          </button>
        ))}
      </div>

      <div className="pt-2 border-t border-border/60">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm">Taker fee</span>
          <span className="font-mono text-sm text-neon">
            {feeBps || "0"} bps · {feePct}%
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={GROUP_MAX_FEE_BPS}
          value={Math.max(1, Math.min(GROUP_MAX_FEE_BPS, parseInt(feeBps || "5", 10) || 5))}
          onChange={(e) => onFee(e.target.value)}
          className="w-full accent-[var(--neon)]"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-1">
          <span>1 bps</span>
          <span>5 bps</span>
          <span>{GROUP_MAX_FEE_BPS} bps</span>
        </div>
      </div>

      <div className="pt-3 border-t border-border/60 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm">Seed deposit (LP collateral)</span>
          <span className="text-[11px] text-muted-foreground">
            Wallet: {walletMusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
            {QUOTE_SYMBOL}
          </span>
        </div>
        <div className="flex items-center gap-2 bg-background/60 border border-border rounded-md px-3 py-2 focus-within:border-neon/60">
          <input
            value={seedLp}
            onChange={(e) => onSeed(e.target.value)}
            inputMode="decimal"
            placeholder="1000"
            className="bg-transparent w-full font-mono text-sm focus:outline-none"
          />
          <span className="text-[10px] text-muted-foreground font-mono">{QUOTE_SYMBOL}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          This funds the new market's House (LP + insurance). Trades match against it, risk is
          isolated to this seed, never the majors pool. Min {MIN_SEED_LP} {QUOTE_SYMBOL}.
        </p>
        {!seedValid && seedNum > 0 && (
          <div className="text-[11px] text-danger">
            {seedNum < MIN_SEED_LP
              ? `Minimum seed is ${MIN_SEED_LP} ${QUOTE_SYMBOL}.`
              : `Not enough ${QUOTE_SYMBOL}, you have ${walletMusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}. Get more from the Faucet.`}
          </div>
        )}
        {walletMusdc < MIN_SEED_LP && (
          <Link to="/faucet" className="text-[11px] text-neon underline inline-block">
            Get {QUOTE_SYMBOL} from the Faucet →
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------- Step 4: Review ----------

function ReviewStep({
  asset,
  oracleKind,
  tier,
  seedPriceUsd,
  feeBps,
  seedLp,
}: {
  asset: DerivedAsset;
  oracleKind: OracleKind;
  tier: RiskTier;
  seedPriceUsd: number | null;
  feeBps: string;
  seedLp: string;
}) {
  return (
    <div className="space-y-4">
      <StepHeader n={4} title="Review & list" />

      <dl className="space-y-2 text-sm">
        <ReviewRow k="Market" v={asset.symbol} />
        <ReviewRow
          k="Underlying"
          v={
            asset.baseMint
              ? `${asset.name} · ${fmtPubkey(asset.baseMint, 4, 4)}`
              : `${asset.name} (synthetic)`
          }
        />
        <ReviewRow
          k="Oracle"
          v={
            oracleKind === "dex"
              ? "DEX pool (EWMA)"
              : oracleKind === "pyth"
                ? "Pyth feed"
                : "Manual"
          }
        />
        <ReviewRow
          k="Seed price"
          v={seedPriceUsd !== null ? `$${seedPriceUsd.toLocaleString()}` : "-"}
        />
        <ReviewRow k="Max leverage" v={`${tier.maxLeverage}×`} />
        <ReviewRow
          k="Taker fee"
          v={`${feeBps || "0"} bps · ${((parseInt(feeBps || "0", 10) || 0) / 100).toFixed(2)}%`}
        />
        <ReviewRow
          k="House seed (LP)"
          v={`${Number(seedLp || "0").toLocaleString()} ${QUOTE_SYMBOL}`}
        />
        <ReviewRow k="Group" v="Isolated (own vault + House)" />
      </dl>

      <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <AlertCircle className="h-3.5 w-3.5 text-violet shrink-0 mt-0.5" />
        <span>
          Creates an <span className="text-foreground">isolated market group</span>: its own vault +
          House, seeded with your {QUOTE_SYMBOL}. Trades match against this House only, risk never
          touches the majors pool. ~3–4 signatures (group rent + your seed). You can withdraw unused
          House LP later (you're the authority).
        </span>
      </div>
    </div>
  );
}

// ---------- aside / progress / success ----------

function SummaryAside({
  asset,
  oracleKind,
  tier,
  seedPriceUsd,
}: {
  asset: DerivedAsset | null;
  oracleKind: OracleKind;
  tier: RiskTier;
  seedPriceUsd: number | null;
}) {
  return (
    <div className="panel p-4 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Market preview
      </div>
      <div className="font-display text-xl font-semibold">{asset?.symbol ?? "-"}</div>
      <dl className="text-[11px] space-y-1 font-mono">
        <PreviewRow k="oracle" v={oracleKind} />
        <PreviewRow k="seed" v={seedPriceUsd !== null ? `$${seedPriceUsd}` : "-"} />
        <PreviewRow k="max lev" v={`${tier.maxLeverage}×`} />
        <PreviewRow k="group" v="isolated" />
      </dl>
    </div>
  );
}

function ProgressPanel({
  progress,
  order,
}: {
  progress: Partial<Record<LaunchStepName, { signature?: string; running?: boolean }>>;
  order: LaunchStepName[];
}) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-3">
        Transaction sequence
      </div>
      <ol className="space-y-3">
        {order.map((step, i) => {
          const st = progress[step];
          const done = !!st?.signature;
          const isRunning = st?.running;
          const meta = TX_META[step];
          return (
            <li key={step} className="flex gap-3">
              <span
                className={`mt-0.5 h-7 w-7 rounded-md flex items-center justify-center border ${
                  done
                    ? "border-success text-success"
                    : isRunning
                      ? "border-neon text-neon"
                      : "border-border text-muted-foreground"
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" />
                ) : isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <TxIcon step={step} />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-muted-foreground">Tx {i + 1}</div>
                <div className="text-sm">{meta.label}</div>
                <div className="text-[11px] text-muted-foreground">{meta.hint}</div>
                {st?.signature && (
                  <a
                    href={`https://explorer.solana.com/tx/${st.signature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-neon hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {fmtPubkey(st.signature, 6, 6)}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SuccessPanel({
  result,
  symbol,
  onGoTerminal,
}: {
  result: LaunchResult;
  symbol: string;
  onGoTerminal: () => void;
}) {
  return (
    <div className="panel p-5 border border-success/40 mt-4">
      <div className="flex items-center gap-2 text-success font-medium">
        <Check className="h-4 w-4" />
        {symbol} launched · isolated group
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        <Row k="Market group" v={result.market.toBase58()} />
        <Row k="Vault" v={result.vault.toBase58()} />
        <Row k="House (LP)" v={result.house.toBase58()} />
        {result.pool && <Row k="Oracle pool" v={result.pool.toBase58()} />}
      </dl>
      <button
        onClick={onGoTerminal}
        className="btn-primary w-full mt-4 rounded-md py-2 text-sm font-medium inline-flex items-center justify-center gap-2"
      >
        Open in Terminal →
      </button>
    </div>
  );
}

// ---------- small UI bits ----------

function TxIcon({ step }: { step: LaunchStepName }) {
  switch (step) {
    case "init-group":
      return <Rocket className="h-3.5 w-3.5" />;
    case "seed-house":
      return <Vault className="h-3.5 w-3.5" />;
    case "create-pool":
      return <Activity className="h-3.5 w-3.5" />;
    case "activate":
      return <Power className="h-3.5 w-3.5" />;
  }
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Step {n} / 4</div>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
    </div>
  );
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}

function PreviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono">
        <a
          href={`https://explorer.solana.com/address/${v}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:text-neon inline-flex items-center gap-1"
        >
          {fmtPubkey(v, 6, 6)}
          <ExternalLink className="h-3 w-3" />
        </a>
      </dd>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-sm">{label}</div>
      <div>{children}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-background/60 border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-neon/60 disabled:opacity-50 ${props.className ?? ""}`}
    />
  );
}
