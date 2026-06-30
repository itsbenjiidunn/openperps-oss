/// Raydium CPMM (constant-product) spot-pool adapter for the native launch path. Creates a
/// token/SOL pool so a freshly launched token is instantly spot-tradeable + routable
/// (Jupiter, dexscreener), and so the pool can become the perp's verifiable DEX-EWMA
/// oracle via SetDexPool.
///
/// `@raydium-io/raydium-sdk-v2` + `bn.js` are OPTIONAL heavy deps, needed only to actually
/// create a pool (which is mainnet-only). They are imported LAZILY so the app builds and
/// typechecks without them; install both to enable this venue:
///   npm i @raydium-io/raydium-sdk-v2 bn.js
///
/// NOTE: mainnet-only and live-unverified here. Pool creation costs ~0.15 SOL (Raydium
/// protocol fee) plus the deposited liquidity. Verify on mainnet before relying on it.

import { PublicKey } from "@solana/web3.js";

import type { DeployContext } from "./types";
import type { SpotPoolProvider, SpotPoolRequest, SpotPoolResult } from "./spotPool";

/// Wrapped SOL mint, the quote side of a token/SOL pool.
const WSOL = "So11111111111111111111111111111111111111112";

/// Lazily load the optional Raydium SDK + BN. Throws a clear, actionable error if absent.
async function loadRaydium(): Promise<{ sdk: any; BN: any }> {
  try {
    // @ts-ignore optional peer dependency; may not be installed
    const sdk = await import("@raydium-io/raydium-sdk-v2");
    // @ts-ignore optional peer dependency; may not be installed
    const bn = await import("bn.js");
    return { sdk, BN: (bn as any).default ?? bn };
  } catch {
    throw new Error(
      "Raydium LP needs `@raydium-io/raydium-sdk-v2` + `bn.js` installed (npm i @raydium-io/raydium-sdk-v2 bn.js).",
    );
  }
}

export const raydiumCpmmProvider: SpotPoolProvider = {
  id: "raydium-cpmm",
  label: "Raydium CPMM",
  available: true,
  async createPool(req: SpotPoolRequest, ctx: DeployContext): Promise<SpotPoolResult> {
    if (req.pair !== "sol") throw new Error("Raydium adapter currently pairs token/SOL only.");
    const { wallet, connection, payer } = ctx;
    if (!wallet.signAllTransactions) {
      throw new Error("This wallet cannot create a Raydium pool (no signAllTransactions).");
    }

    const { sdk, BN } = await loadRaydium();
    const { Raydium, TxVersion, CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC } = sdk;

    // Browser wallet flow: load with the wallet's public key + signAllTransactions, so the
    // SDK's execute() delegates signing to the wallet instead of a server keypair.
    const raydium = await Raydium.load({
      connection,
      owner: payer,
      signAllTransactions: wallet.signAllTransactions,
      cluster: "mainnet",
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });

    // mintA = the freshly launched token, mintB = WSOL. getTokenInfo resolves each mint's
    // decimals + token program; the SDK normalises mint ordering internally.
    const mintA = await raydium.token.getTokenInfo(req.mint.toBase58());
    const mintB = await raydium.token.getTokenInfo(WSOL);
    const feeConfigs = await raydium.api.getCpmmConfigs();

    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId: CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
      mintA,
      mintB,
      mintAAmount: new BN(req.tokenAmount.toString()),
      mintBAmount: new BN(req.solLamports.toString()),
      startTime: new BN(0),
      feeConfig: feeConfigs[0],
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return {
      venue: "raydium-cpmm",
      poolId: new PublicKey(extInfo.address.poolId),
      signature: txId,
    };
  },
};
