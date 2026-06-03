/// DEX-EWMA oracle devnet controls: move a market's mock DEX pool (MockSwap) and
/// pull a fresh EWMA mark from it (CrankOracle). Both are permissionless,
/// any signer can call, which is the whole point: the price lives in the
/// pool, not with a trusted keeper.

import { Connection, PublicKey, Transaction, type Commitment } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { crankOracleIx, mockSwapIx } from "@openperps/sdk";

import { PROGRAM_ID } from "../program";

const CONFIRM_COMMITMENT: Commitment = "confirmed";

async function send(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return sig;
}

/// Swap against the mock pool to move its price. `baseToQuote` true sells
/// base (price down); false buys base (price up).
export async function mockSwapFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  pool: PublicKey;
  amountIn: bigint;
  baseToQuote: boolean;
}): Promise<{ signature: string }> {
  const { wallet, connection, pool, amountIn, baseToQuote } = args;
  const tx = new Transaction().add(
    mockSwapIx({
      programId: PROGRAM_ID,
      pool,
      signer: wallet.publicKey!,
      amountIn,
      baseToQuote,
    }),
  );
  return { signature: await send(connection, wallet, tx) };
}

/// Pull a fresh EWMA mark from the pinned pool into the market.
export async function crankOracleFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  market: PublicKey;
  pool: PublicKey;
  assetIndex?: number;
}): Promise<{ signature: string }> {
  const { wallet, connection, market, pool } = args;
  const tx = new Transaction().add(
    crankOracleIx({
      programId: PROGRAM_ID,
      market,
      pool,
      signer: wallet.publicKey!,
      assetIndex: args.assetIndex ?? 0,
    }),
  );
  return { signature: await send(connection, wallet, tx) };
}
