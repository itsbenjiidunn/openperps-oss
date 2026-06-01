/// Shared devnet collateral mint. EVERY OpenPerps market quotes against
/// this single mock-USDC mint, so a trader funds their wallet once (via the
/// Faucet) and can deposit into any market. This is the decoupling that
/// makes "launch a market" mean *bind an existing asset to an oracle*, not
/// *mint a brand-new token*.
///
/// The mint authority secret below is intentionally public. It is a
/// throwaway devnet keypair that only ever signs `MintTo` for the faucet;
/// it holds no SOL and controls nothing of value. NEVER reuse this pattern
/// on mainnet — there, collateral is real USDC with no app-held authority.

import { Keypair, PublicKey } from "@solana/web3.js";

import { QUOTE_DECIMALS } from "./decimals";

export const QUOTE_SYMBOL = "mUSDC";

/// Shared mock-USDC mint, created once on devnet via
/// `ts/sdk/scripts/create-musdc.ts`. Override per-cluster with
/// `VITE_OPENPERPS_QUOTE_MINT`.
const QUOTE_MINT_STRING =
  import.meta.env.VITE_OPENPERPS_QUOTE_MINT ??
  "9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat";

export const QUOTE_MINT = new PublicKey(QUOTE_MINT_STRING);

/// Faucet mint-authority keypair (devnet only — see file header).
const FAUCET_AUTHORITY_SECRET = Uint8Array.from([
  196, 54, 13, 224, 137, 112, 196, 54, 209, 253, 170, 100, 165, 253, 25, 148,
  147, 110, 191, 122, 1, 40, 253, 13, 144, 18, 185, 162, 114, 77, 87, 137, 185,
  53, 215, 136, 178, 161, 13, 254, 6, 192, 49, 243, 149, 196, 166, 33, 65, 189,
  148, 254, 151, 211, 73, 181, 244, 232, 61, 255, 155, 180, 153, 76,
]);

export const FAUCET_AUTHORITY = Keypair.fromSecretKey(FAUCET_AUTHORITY_SECRET);

/// Default faucet drip: 10,000 mUSDC in atoms.
export const FAUCET_DRIP_ATOMS = 10_000n * 10n ** BigInt(QUOTE_DECIMALS);
