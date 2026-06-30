/// Pump.fun + LetsBonk launch providers, via PumpPortal's LOCAL transaction API. This is
/// non-custodial: PumpPortal builds the `create` (+ optional dev-buy) transaction and
/// returns it serialized; the dev's own wallet co-signs it with the fresh mint keypair
/// and sends it. No API key is needed for the local endpoint.
///
/// The dev-bought bag is what seeds the coin-margin perp (the aggregator reads the
/// creator's token balance after the create confirms and sizes the seed from it).
///
/// Endpoint + contract: https://pumpportal.fun/creation  (POST /api/trade-local).

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import type { DeployContext, DeployPlan, LaunchProvider, TokenLaunchRequest } from "./types";

const TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";
/// Pump.fun and LetsBonk both mint their launch tokens at 6 decimals.
const EXTERNAL_DECIMALS = 6;

/// Build a Pump.fun (`pool: "pump"`) or LetsBonk (`pool: "bonk"`) provider.
export function pumpPortalProvider(pool: "pump" | "bonk"): LaunchProvider {
  const label = pool === "pump" ? "Pump.fun" : "LetsBonk";
  return {
    id: pool === "pump" ? "pumpfun" : "bonk",
    label,
    fromDevBuy: true,
    async deployToken(req: TokenLaunchRequest, ctx: DeployContext): Promise<DeployPlan> {
      if (!req.metadataUri) {
        throw new Error(`${label} launch needs a metadata URI (upload the image + JSON to IPFS first)`);
      }
      // A fresh mint keypair; it co-signs the create tx. (Vanity grinding -> a future
      // option; PumpPortal accepts any mint pubkey here.)
      const mintKp = Keypair.generate();
      const body = {
        publicKey: ctx.payer.toBase58(),
        action: "create",
        tokenMetadata: { name: req.name, symbol: req.symbol, uri: req.metadataUri },
        mint: mintKp.publicKey.toBase58(),
        // The dev-buy amount is in SOL.
        denominatedInSol: "true",
        amount: req.devBuySol ?? 0,
        slippage: req.slippagePct ?? 10,
        priorityFee: req.priorityFeeSol ?? 0.0005,
        pool,
      };
      const res = await fetch(TRADE_LOCAL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`PumpPortal create failed (${res.status}): ${await res.text()}`);
      }
      // The local endpoint returns the serialized VersionedTransaction (with a recent
      // blockhash already set). The aggregator co-signs it with `mintKp` + the wallet.
      const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
      const mint = mintKp.publicKey;
      return {
        mint,
        // A Pump/Bonk dev-buy credits the creator's associated token account.
        creatorTokenAccount: getAssociatedTokenAddressSync(mint, ctx.payer),
        decimals: EXTERNAL_DECIMALS,
        steps: [{ label: `Create on ${label} (+ dev-buy)`, tx, signers: [mintKp] }],
      };
    },
  };
}

export const pumpfunProvider = pumpPortalProvider("pump");
export const bonkProvider = pumpPortalProvider("bonk");
