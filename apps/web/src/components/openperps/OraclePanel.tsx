/// DEX-EWMA oracle control panel. For DEX-priced markets it shows the
/// pinned pool's live spot price and the market's on-chain EWMA mark, and
/// lets anyone move the pool (mock swaps) and crank a fresh mark, making
/// the "price comes from an on-chain pool, no keeper" mechanic tangible.

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { poolSpotPrice, PRICE_SCALE } from "@opp-oss/sdk";

import { fmtPubkey } from "@/lib/format";
import { crankOracleFlow, mockSwapFlow } from "@/lib/flows/oracleFlows";
import { humanToAtoms } from "@/lib/decimals";
import type { Market } from "@/lib/types";

export function OraclePanel({ market }: { market: Market }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [running, setRunning] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapHuman, setSwapHuman] = useState("1000");

  const spotQ = usePoolSpot(market.oraclePool);

  if (market.oracleKind !== "dex" || !market.oraclePool) {
    return null;
  }
  const pool = market.oraclePool;

  const fmtUsd = (usd: number) => (usd >= 1 ? usd.toFixed(2) : usd.toFixed(6));

  const act = async (key: string, fn: () => Promise<{ signature: string }>) => {
    setError(null);
    setSig(null);
    setRunning(key);
    try {
      const r = await fn();
      setSig(r.signature);
      await spotQ.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const swapAmount = (() => {
    try {
      return humanToAtoms(swapHuman);
    } catch {
      return 0n;
    }
  })();

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-electric" />
        <div className="text-xs font-medium">DEX-EWMA oracle</div>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-electric/15 text-electric">
          DEX · no keeper
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
        <div className="rounded-md border border-border/70 p-2">
          <div className="text-muted-foreground text-[10px]">Pool spot</div>
          <div className="text-sm">
            {spotQ.data !== undefined && spotQ.data !== null ? `$${fmtUsd(spotQ.data)}` : "-"}
          </div>
        </div>
        <div className="rounded-md border border-border/70 p-2">
          <div className="text-muted-foreground text-[10px]">Mark (EWMA)</div>
          <div className="text-sm">{market.price > 0 ? `$${fmtUsd(market.price)}` : "-"}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={swapHuman}
          onChange={(e) => setSwapHuman(e.target.value)}
          inputMode="decimal"
          className="flex-1 bg-background/60 border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-neon/60"
        />
        <span className="text-[10px] text-muted-foreground font-mono">{market.base}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          disabled={!wallet.connected || !!running || swapAmount <= 0n}
          onClick={() =>
            act("buy", () =>
              mockSwapFlow({
                wallet,
                connection,
                pool: new PublicKey(pool),
                amountIn: swapAmount,
                baseToQuote: false,
              }),
            )
          }
          className="btn-long rounded-md py-1.5 text-xs font-medium inline-flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {running === "buy" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )}
          Buy → up
        </button>
        <button
          disabled={!wallet.connected || !!running || swapAmount <= 0n}
          onClick={() =>
            act("sell", () =>
              mockSwapFlow({
                wallet,
                connection,
                pool: new PublicKey(pool),
                amountIn: swapAmount,
                baseToQuote: true,
              }),
            )
          }
          className="btn-short rounded-md py-1.5 text-xs font-medium inline-flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {running === "sell" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )}
          Sell → down
        </button>
      </div>

      <button
        disabled={!wallet.connected || !!running}
        onClick={() =>
          act("crank", () =>
            crankOracleFlow({
              wallet,
              connection,
              market: new PublicKey(market.pubkey),
              pool: new PublicKey(pool),
              assetIndex: market.assetIndex,
            }),
          )
        }
        className="btn-primary w-full rounded-md py-1.5 text-xs font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
      >
        {running === "crank" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Crank oracle (fold spot → mark)
      </button>

      {sig && (
        <a
          href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-success inline-flex items-center gap-1"
        >
          <Check className="h-3 w-3" />
          {fmtPubkey(sig, 6, 6)}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {error && <div className="text-[11px] text-danger break-words">{error}</div>}

      <div className="text-[10px] text-muted-foreground">
        Pool {fmtPubkey(pool, 4, 4)}. Swaps move the pool; the EWMA (α=0.2) nudges the mark toward
        spot each crank, anyone can crank.
      </div>
    </div>
  );
}

function usePoolSpot(pool: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["pool-spot", pool, connection.rpcEndpoint],
    enabled: !!pool,
    queryFn: async () => {
      const info = await connection.getAccountInfo(new PublicKey(pool!));
      if (!info) return null;
      const spot = poolSpotPrice(new Uint8Array(info.data));
      return Number(spot) / Number(PRICE_SCALE);
    },
    refetchInterval: 4_000,
  });
}
