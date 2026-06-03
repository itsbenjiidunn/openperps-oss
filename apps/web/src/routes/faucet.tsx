/// Devnet faucet, mint shared mock-USDC into your wallet so you have
/// collateral to deposit into any market. This is deliberately separate
/// from "Launch a market": minting test collateral is a setup step, not
/// the act of creating a perp market.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/openperps/WalletButton";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import { Check, Coins, Droplets, ExternalLink, Loader2, Wallet } from "lucide-react";

import { fmtPubkey } from "@/lib/format";
import { faucetFlow } from "@/lib/flows/faucetFlow";
import { FAUCET_DRIP_ATOMS, QUOTE_MINT, QUOTE_SYMBOL } from "@/lib/collateral";
import { atomsToHuman } from "@/lib/decimals";

export const Route = createFileRoute("/faucet")({
  head: () => ({
    meta: [
      { title: "Faucet: OpenPerps" },
      {
        name: "description",
        content: "Mint mock-USDC test collateral to deposit into any OpenPerps market.",
      },
    ],
  }),
  component: Faucet,
});

function Faucet() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const balanceQ = useMusdcBalance();
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrip = async () => {
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      const r = await faucetFlow({ wallet, connection });
      setSig(r.signature);
      await balanceQ.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="px-4 py-10 max-w-2xl mx-auto">
      <header className="flex items-start gap-4 mb-6">
        <div className="p-2.5 rounded-md panel-flat glow-border">
          <Droplets className="h-5 w-5 text-neon" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Test collateral faucet
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every OpenPerps market is margined in the same shared mock-USDC. Mint some here once,
            then deposit it into any market's trading account. This is test collateral, not the
            asset you trade.
          </p>
        </div>
      </header>

      {!wallet.connected ? (
        <div className="panel p-6 flex items-center gap-4">
          <Wallet className="h-5 w-5 text-neon" />
          <div className="flex-1">
            <p className="font-medium">Connect a wallet to claim mUSDC.</p>
            <p className="text-xs text-muted-foreground">
              You pay only the network fee (~0.00001 SOL) plus a one-time ATA rent if this is your
              first claim.
            </p>
          </div>
          <WalletButton />
        </div>
      ) : (
        <div className="panel p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Your balance
              </div>
              <div className="font-mono text-2xl mt-1">
                {balanceQ.data !== undefined
                  ? `${atomsToHuman(balanceQ.data, undefined, true)} ${QUOTE_SYMBOL}`
                  : balanceQ.isLoading
                    ? "…"
                    : `0 ${QUOTE_SYMBOL}`}
              </div>
            </div>
            <Coins className="h-8 w-8 text-neon/60" />
          </div>

          <button
            onClick={onDrip}
            disabled={running}
            className="btn-primary w-full rounded-md py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Droplets className="h-4 w-4" />
            )}
            {running
              ? "Minting…"
              : `Mint ${atomsToHuman(FAUCET_DRIP_ATOMS, undefined, true)} ${QUOTE_SYMBOL}`}
          </button>

          {sig && (
            <div className="flex items-center gap-1.5 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              <a
                href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {fmtPubkey(sig, 6, 6)}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {error && (
            <div className="panel-flat border border-danger/50 p-3 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-border/60 text-[11px] text-muted-foreground space-y-1">
            <div className="flex items-center justify-between">
              <span>Shared mint</span>
              <a
                href={`https://explorer.solana.com/address/${QUOTE_MINT.toBase58()}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:text-neon inline-flex items-center gap-1"
              >
                {fmtPubkey(QUOTE_MINT.toBase58(), 6, 6)}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <p>
              6 decimals. The mint authority is an app-held keypair, fine here because the token is
              worthless test collateral.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function useMusdcBalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  return useQuery({
    queryKey: ["musdc-balance", wallet.publicKey?.toBase58(), connection.rpcEndpoint],
    enabled: !!wallet.publicKey,
    queryFn: async () => {
      const ata = getAssociatedTokenAddressSync(QUOTE_MINT, wallet.publicKey!);
      try {
        const acct = await getAccount(connection, ata);
        return acct.amount;
      } catch {
        return 0n;
      }
    },
    refetchInterval: 5_000,
  });
}
