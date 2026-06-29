/// OPP Launchpad panel: mint a token AND launch a coin-margin perp on it in one flow.
/// The creator allocation seeds the perp House (productive, not locked), optionally
/// behind a rug-proof timelock. Wired to the real launchpad flow.

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Loader2, Rocket, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  launchpad,
  type LaunchpadParams,
  type LaunchpadProgress,
  type LaunchpadResult,
} from "@/lib/flows/launchpadFlow";

const DECIMALS = 6;

export function LaunchpadPanel() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [totalSupply, setTotalSupply] = useState("1000000000"); // human units
  const [allocation, setAllocation] = useState("100000000"); // human units seeded to House
  const [priceUsd, setPriceUsd] = useState("0.0001");
  const [lockDays, setLockDays] = useState("0");

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<LaunchpadProgress | null>(null);
  const [result, setResult] = useState<LaunchpadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = !!wallet.publicKey;

  async function onLaunch() {
    setError(null);
    setResult(null);
    if (!connected) {
      setError("Connect a wallet first.");
      return;
    }
    let params: LaunchpadParams;
    try {
      const scale = 10 ** DECIMALS;
      const supplyAtoms = BigInt(Math.round(Number(totalSupply) * scale));
      const allocAtoms = BigInt(Math.round(Number(allocation) * scale));
      if (allocAtoms > supplyAtoms) throw new Error("Allocation exceeds total supply.");
      // ~2.5 slots/sec on devnet; lock for the requested number of days.
      const lockForSlots = Math.max(0, Math.round(Number(lockDays) * 86_400 * 2.5));
      params = {
        name,
        symbol,
        decimals: DECIMALS,
        totalSupply: supplyAtoms,
        allocationAtoms: allocAtoms,
        launchPriceUsd: Number(priceUsd),
        revokeMintAuthority: true,
        ...(name && symbol ? { metadata: { name, symbol } } : {}),
        ...(lockForSlots > 0 ? { lockForSlots } : {}),
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      const res = await launchpad({ wallet, connection, params, onProgress: setStep });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const field = (
    label: string,
    value: string,
    setter: (v: string) => void,
    placeholder?: string,
  ) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => setter(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
      />
    </div>
  );

  return (
    <div className="space-y-4 rounded-xl border p-5">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <Rocket className="h-5 w-5" /> Launch a token with a perp
      </div>
      <p className="text-sm text-muted-foreground">
        Mint a token and stand up a coin-margin perp on it. Instead of locking your
        allocation, it seeds the House and earns the House edge. Auto-capped at 5x.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {field("Name", name, setName, "My Token")}
        {field("Symbol", symbol, setSymbol, "MYT")}
        {field("Total supply", totalSupply, setTotalSupply)}
        {field("Allocation -> House", allocation, setAllocation)}
        {field("Launch price (USD)", priceUsd, setPriceUsd)}
        {field("Lock House (days)", lockDays, setLockDays, "0 = no lock")}
      </div>

      <Button onClick={onLaunch} disabled={busy || !connected} className="w-full">
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {step ? `Step: ${step.step}...` : "Launching..."}
          </>
        ) : (
          "Launch"
        )}
      </Button>

      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {result ? (
        <div className="space-y-1 rounded-lg border border-green-600/40 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-green-500">
            <Check className="h-4 w-4" /> Launched
          </div>
          <div className="break-all text-muted-foreground">
            token {result.mint.toBase58()}
          </div>
          <div className="break-all text-muted-foreground">
            market {result.market.toBase58()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
