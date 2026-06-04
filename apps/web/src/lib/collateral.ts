/// Shared collateral mint. EVERY OpenPerps market quotes against this single
/// mock-USDC mint, so a trader funds their wallet once and can deposit into any
/// market. This is the decoupling that makes "launch a market" mean *bind an
/// existing asset to an oracle*, not *mint a brand-new token*.

import { PublicKey } from "@solana/web3.js";

export const QUOTE_SYMBOL = "mUSDC";

/// Shared mock-USDC mint. Override per-cluster with `VITE_OPENPERPS_QUOTE_MINT`.
const QUOTE_MINT_STRING =
  import.meta.env.VITE_OPENPERPS_QUOTE_MINT ?? "9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat";

export const QUOTE_MINT = new PublicKey(QUOTE_MINT_STRING);
