/// Devnet faucet: mint shared mock-USDC into the connected wallet's ATA so
/// it has collateral to deposit into any market. The mint authority is the
/// app-baked throwaway keypair (see collateral.ts) — it co-signs the
/// MintTo; the user's wallet pays fees and creates its ATA if missing.

import { Connection, PublicKey, Transaction, type Commitment } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { FAUCET_AUTHORITY, FAUCET_DRIP_ATOMS, QUOTE_MINT } from "../collateral";

const CONFIRM_COMMITMENT: Commitment = "confirmed";

export async function faucetFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  amount?: bigint;
}): Promise<{ signature: string; ata: PublicKey }> {
  const { wallet, connection } = args;
  const amount = args.amount ?? FAUCET_DRIP_ATOMS;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey;
  const ata = getAssociatedTokenAddressSync(QUOTE_MINT, owner);

  const tx = new Transaction();

  // Create the ATA if it does not exist yet.
  let ataExists = true;
  try {
    await getAccount(connection, ata);
  } catch {
    ataExists = false;
  }
  if (!ataExists) {
    tx.add(createAssociatedTokenAccountInstruction(owner, ata, owner, QUOTE_MINT));
  }

  tx.add(createMintToInstruction(QUOTE_MINT, ata, FAUCET_AUTHORITY.publicKey, amount));

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  // The faucet authority co-signs the MintTo; the wallet adds its own sig.
  const sig = await wallet.sendTransaction(tx, connection, {
    signers: [FAUCET_AUTHORITY],
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return { signature: sig, ata };
}
