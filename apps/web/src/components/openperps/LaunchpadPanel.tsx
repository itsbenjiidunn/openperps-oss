/// OPP Launchpad aggregator panel. OpenPerps is the intermediary: the dev picks a token
/// origin (Native mint / Pump.fun / LetsBonk), and the same flow stands up a coin-margin
/// perp on the token. The native path can also add a real spot pool (dev picks the venue).
/// Non-custodial: the dev's wallet signs every step.

import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Loader2, Rocket, Check, Coins, Image as ImageIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  aggregatorLaunch,
  type AggregatorProgress,
  type AggregatorResult,
  type AggregatorPerpConfig,
  type AggregatorSpotLp,
} from "@/lib/launch/aggregatorFlow";
import { getLaunchProvider } from "@/lib/launch/providers";
import { SPOT_POOL_VENUES, type SpotPoolVenueId } from "@/lib/launch/spotPool";
import { defaultUploader } from "@/lib/launch/ipfs";
import type { LaunchProviderId, TokenLaunchRequest } from "@/lib/launch/types";

const PROVIDERS: { id: LaunchProviderId; label: string; blurb: string }[] = [
  { id: "native", label: "Native", blurb: "OpenPerps mints the token; add your own LP pool" },
  { id: "pumpfun", label: "Pump.fun", blurb: "Bonding curve via PumpPortal; perp on your dev-buy" },
  { id: "bonk", label: "LetsBonk", blurb: "Bonk curve via PumpPortal; perp on your dev-buy" },
];

const LP_SOL_DECIMALS = 9;

export function LaunchpadPanel() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const connected = !!wallet.publicKey;

  const [providerId, setProviderId] = useState<LaunchProviderId>("native");
  const isNative = providerId === "native";

  // Common.
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [priceUsd, setPriceUsd] = useState("0.0001");
  const [lockDays, setLockDays] = useState("0");

  // Native.
  const [decimals, setDecimals] = useState("6");
  const [totalSupply, setTotalSupply] = useState("1000000000");
  const [perpAlloc, setPerpAlloc] = useState("100000000"); // token units seeded to the perp House
  const [addLp, setAddLp] = useState(false);
  const [lpVenue, setLpVenue] = useState<SpotPoolVenueId>("raydium-cpmm");
  const [lpToken, setLpToken] = useState("100000000"); // token units into the spot pool
  const [lpSol, setLpSol] = useState("1"); // SOL into the spot pool

  // External (pump/bonk).
  const [devBuySol, setDevBuySol] = useState("0.5");
  const [slippage, setSlippage] = useState("10");
  const [perpPct, setPerpPct] = useState("50"); // % of the dev-buy bag seeded to the perp

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<AggregatorProgress | null>(null);
  const [result, setResult] = useState<AggregatorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasPinata = useMemo(() => !!defaultUploader(), []);

  async function onLaunch() {
    setError(null);
    setResult(null);
    if (!connected) {
      setError("Connect a wallet first.");
      return;
    }
    let request: TokenLaunchRequest;
    let perp: AggregatorPerpConfig;
    let spotLp: AggregatorSpotLp | undefined;
    try {
      const lockForSlots = Math.max(0, Math.round(Number(lockDays) * 86_400 * 2.5));
      if (isNative) {
        const dec = Number(decimals) || 6;
        const scale = 10 ** dec;
        const supply = BigInt(Math.round(Number(totalSupply) * scale));
        const allocAtoms = BigInt(Math.round(Number(perpAlloc) * scale));
        const lpTokenAtoms = addLp ? BigInt(Math.round(Number(lpToken) * scale)) : 0n;
        if (allocAtoms + lpTokenAtoms > supply) {
          throw new Error("Perp allocation + LP tokens exceed total supply.");
        }
        request = { name, symbol, decimals: dec, totalSupply: supply, revokeMintAuthority: true };
        perp = {
          allocation: { atoms: allocAtoms },
          launchPriceUsd: Number(priceUsd),
          ...(lockForSlots > 0 ? { lockForSlots } : {}),
        };
        if (addLp) {
          spotLp = {
            venue: lpVenue,
            tokenAmount: lpTokenAtoms,
            solLamports: BigInt(Math.round(Number(lpSol) * 10 ** LP_SOL_DECIMALS)),
          };
        }
      } else {
        request = {
          name,
          symbol,
          devBuySol: Number(devBuySol) || 0,
          slippagePct: Number(slippage) || 10,
        };
        perp = {
          allocation: { pctOfBag: (Number(perpPct) || 0) / 100 },
          launchPriceUsd: Number(priceUsd),
          ...(lockForSlots > 0 ? { lockForSlots } : {}),
        };
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setBusy(true);
    try {
      const res = await aggregatorLaunch({
        wallet,
        connection,
        provider: getLaunchProvider(providerId),
        request,
        perp,
        ...(spotLp ? { spotLp } : {}),
        uploader: defaultUploader(),
        ...(image ? { image } : {}),
        onProgress: setStep,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  return (
    <div className="space-y-5 rounded-xl border p-5">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <Rocket className="h-5 w-5" /> Launch a token with a perp
      </div>

      {/* provider selector */}
      <div className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProviderId(p.id)}
            disabled={busy}
            className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
              providerId === p.id
                ? "border-neon bg-[oklch(0.86_0.16_188_/_0.06)]"
                : "border-border hover:border-neon/50"
            }`}
          >
            <div className="text-sm font-medium">{p.label}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{p.blurb}</div>
          </button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {isNative
          ? "OpenPerps mints your token (full supply to you). Seed the coin-margin perp from your allocation, and optionally add a real spot pool. Auto-capped at 5x."
          : "PumpPortal builds the create (+ dev-buy) tx; your wallet signs it with the fresh mint. The perp is coin-margin, seeded by a slice of your dev-buy bag. Auto-capped at 5x."}
      </p>

      {/* common token fields */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" value={name} onChange={setName} placeholder="My Token" disabled={busy} />
        <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="MYT" disabled={busy} />
      </div>

      <div className="space-y-1">
        <Label className="flex items-center gap-1.5">
          <ImageIcon className="h-3.5 w-3.5" /> Image {hasPinata ? "" : "(needs VITE_PINATA_JWT)"}
        </Label>
        <Input
          type="file"
          accept="image/*"
          disabled={busy || (!isNative && !hasPinata)}
          onChange={(e) => setImage(e.target.files?.[0] ?? null)}
        />
        {!isNative && !hasPinata ? (
          <p className="text-[11px] text-amber-500">
            Pump/Bonk need a metadata URI: set VITE_PINATA_JWT to pin the image + JSON.
          </p>
        ) : null}
      </div>

      {/* provider-specific */}
      {isNative ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Decimals" value={decimals} onChange={setDecimals} disabled={busy} />
            <Field label="Total supply" value={totalSupply} onChange={setTotalSupply} disabled={busy} />
            <Field label="Allocation -> perp" value={perpAlloc} onChange={setPerpAlloc} disabled={busy} />
          </div>

          {/* optional spot LP */}
          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={addLp}
                disabled={busy}
                onChange={(e) => setAddLp(e.target.checked)}
              />
              <Coins className="h-4 w-4" /> Add a spot LP pool (token / SOL)
            </label>
            {addLp ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label>Venue</Label>
                  <select
                    value={lpVenue}
                    disabled={busy}
                    onChange={(e) => setLpVenue(e.target.value as SpotPoolVenueId)}
                    className="w-full rounded-md border bg-background/60 px-3 py-2 text-sm"
                  >
                    {SPOT_POOL_VENUES.map((v) => (
                      <option key={v.id} value={v.id} disabled={!v.available}>
                        {v.label}
                        {v.available ? "" : " (needs SDK)"}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="Tokens -> LP" value={lpToken} onChange={setLpToken} disabled={busy} />
                <Field label="SOL -> LP" value={lpSol} onChange={setLpSol} disabled={busy} />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Dev-buy (SOL)" value={devBuySol} onChange={setDevBuySol} disabled={busy} />
          <Field label="Slippage (%)" value={slippage} onChange={setSlippage} disabled={busy} />
          <Field label="Bag -> perp (%)" value={perpPct} onChange={setPerpPct} disabled={busy} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Launch price (USD)" value={priceUsd} onChange={setPriceUsd} disabled={busy} />
        <Field
          label="Lock House (days)"
          value={lockDays}
          onChange={setLockDays}
          placeholder="0 = no lock"
          disabled={busy}
        />
      </div>

      <Button onClick={onLaunch} disabled={busy || !connected} className="w-full">
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {step ? `${step.step}${step.detail ? `: ${step.detail}` : ""}...` : "Launching..."}
          </>
        ) : (
          "Launch"
        )}
      </Button>

      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {result ? (
        <div className="space-y-1 rounded-lg border border-green-600/40 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-green-500">
            <Check className="h-4 w-4" /> Launched via {result.provider}
          </div>
          <div className="break-all text-muted-foreground">token {result.mint.toBase58()}</div>
          <div className="break-all text-muted-foreground">market {result.market.toBase58()}</div>
          {result.poolId ? (
            <div className="break-all text-muted-foreground">pool {result.poolId.toBase58()}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}
