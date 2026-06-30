/// Multi-venue spot-LP abstraction for the launch aggregator. When a dev launches a token
/// natively (NOT via Pump/Bonk/Bags, which carry their own bonding curve), OpenPerps can
/// also add a real spot pool so the token is instantly spot-tradeable, and so the pool's
/// on-chain EWMA can later become the perp's verifiable DEX-EWMA oracle (via SetDexPool).
///
/// The dev chooses the AMM venue. Raydium CPMM is wired; Meteora / Orca are recognised and
/// selectable but gated (their SDKs are not wired yet) so the structure is honest and
/// extensible. All pool creation is mainnet-only and live-unverified here.

import type { PublicKey } from "@solana/web3.js";
import type { DeployContext } from "./types";
import { raydiumCpmmProvider } from "./raydiumCpmm";

export type SpotPoolVenueId = "raydium-cpmm" | "meteora-dlmm" | "orca-whirlpool";

export interface SpotPoolRequest {
  mint: PublicKey;
  decimals: number;
  /// Quote side of the pair. Only SOL for now (token/SOL).
  pair: "sol";
  /// Base liquidity: token atoms to deposit.
  tokenAmount: bigint;
  /// Quote liquidity: lamports of SOL to deposit. Together with tokenAmount this sets the
  /// pool's opening price (solLamports / tokenAmount, scaled by decimals).
  solLamports: bigint;
}

export interface SpotPoolResult {
  venue: SpotPoolVenueId;
  poolId: PublicKey;
  signature: string;
}

export interface SpotPoolProvider {
  id: SpotPoolVenueId;
  label: string;
  /// False = the venue is recognised + selectable but its SDK is not wired yet (createPool
  /// throws with a clear message). Lets the UI show the option honestly.
  available: boolean;
  createPool(req: SpotPoolRequest, ctx: DeployContext): Promise<SpotPoolResult>;
}

/// A recognised-but-not-yet-wired venue: selectable in the UI, throws on use with the dep
/// to install. Keeps the multi-venue abstraction honest until the adapter is filled in.
function scaffoldVenue(id: SpotPoolVenueId, label: string, dep: string): SpotPoolProvider {
  return {
    id,
    label,
    available: false,
    async createPool(): Promise<SpotPoolResult> {
      throw new Error(`${label} LP is not wired yet. Install ${dep} and implement its adapter (mainnet-only).`);
    },
  };
}

export const SPOT_POOL_VENUES: SpotPoolProvider[] = [
  raydiumCpmmProvider,
  scaffoldVenue("meteora-dlmm", "Meteora DLMM", "@meteora-ag/dlmm"),
  scaffoldVenue("orca-whirlpool", "Orca Whirlpools", "@orca-so/whirlpools-sdk"),
];

export function getSpotPoolProvider(id: SpotPoolVenueId): SpotPoolProvider {
  const provider = SPOT_POOL_VENUES.find((v) => v.id === id);
  if (!provider) throw new Error(`Unknown spot-pool venue: ${id}`);
  return provider;
}
