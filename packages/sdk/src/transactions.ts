import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

export type TransactionBuildOptions = {
  feePayer?: PublicKey;
  recentBlockhash?: BlockhashWithExpiryBlockHeight;
};

/// Wrap instructions in a `Transaction` without signing or sending, so a
/// browser app can hand the transaction to a wallet to sign itself. Optionally
/// sets the fee payer and a recent blockhash.
export function transactionFromInstructions(
  instructions: TransactionInstruction[],
  options: TransactionBuildOptions = {},
): Transaction {
  const tx = new Transaction();
  if (options.feePayer) tx.feePayer = options.feePayer;
  if (options.recentBlockhash) {
    tx.recentBlockhash = options.recentBlockhash.blockhash;
    tx.lastValidBlockHeight = options.recentBlockhash.lastValidBlockHeight;
  }
  for (const ix of instructions) tx.add(ix);
  return tx;
}
