import { PublicKey } from "@solana/web3.js";
import { portfolioPda } from "@opp-oss/sdk";

/// OpenPerps program ID, devnet deployment from commit 3daf907.
/// Override via `VITE_OPENPERPS_PROGRAM_ID` for a different cluster /
/// upgraded program.
const PROGRAM_ID_STRING =
  import.meta.env.VITE_OPENPERPS_PROGRAM_ID ?? "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy";

export const PROGRAM_ID = new PublicKey(PROGRAM_ID_STRING);

/// The deterministic portfolio account for `(owner, market)` as a base58 string.
/// One account per wallet per market group, derivable on any device, replaces
/// the old random-keypair-in-localStorage lookup. The account may not exist
/// on-chain yet (until the user inits it); callers that need existence check the
/// account data (e.g. `usePortfolioState`) or the batched positions read.
export function userPortfolio(owner: string, marketPubkey: string): string {
  return portfolioPda(PROGRAM_ID, new PublicKey(owner), new PublicKey(marketPubkey))[0].toBase58();
}
