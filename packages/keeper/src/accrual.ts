/// Build the `AccrueAsset` instructions for one asset this cycle, including burst
/// catch-up when the asset has fallen behind (see freshness.ts). A large price
/// jump is split into steps that each respect the engine's per-slot move bound,
/// so no single accrual is rejected for moving the price too far too fast. The
/// keeper signer must be the market's pinned oracle authority, or the program
/// rejects these.

import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { accrueAssetIx } from "@openperps/sdk";
import { planAccrualSteps } from "./freshness.ts";

export function buildAccrualInstructions(args: {
  programId: PublicKey;
  market: PublicKey;
  /// The oracle authority that signs the accruals.
  authority: PublicKey;
  assetIndex: number;
  /// The asset's current on-chain mark (EWMA `effective_price`), or 0 if it has
  /// never been accrued. With no prior mark the first accrual seeds it and is not
  /// subject to the per-slot move bound.
  oldMark: bigint;
  /// Target price to reach this cycle, in the market's price scale.
  effectivePrice: bigint;
  fundingRateE9?: bigint;
  slotLast: number;
  nowSlot: number;
  maxAccrualDtSlots: number;
  /// The market's `max_price_move_bps_per_slot`: caps how far each catch-up
  /// accrual may advance the price, so a large jump is split across steps.
  maxPriceMoveBpsPerSlot: number;
  /// Optional per-market oracle authority PDA (from the SDK `oracleAuthorityPda`).
  /// Passed through to each `AccrueAsset` so a market with a custom oracle
  /// authority is priced by `authority`; omit for relayer-constant markets.
  oracleAuthority?: PublicKey;
  maxSteps?: number;
}): TransactionInstruction[] {
  const steps = planAccrualSteps({
    oldMark: args.oldMark,
    targetMark: args.effectivePrice,
    slotLast: args.slotLast,
    nowSlot: args.nowSlot,
    maxAccrualDtSlots: args.maxAccrualDtSlots,
    maxPriceMoveBpsPerSlot: args.maxPriceMoveBpsPerSlot,
    maxSteps: args.maxSteps,
  });

  return steps.map((step) =>
    accrueAssetIx({
      programId: args.programId,
      market: args.market,
      authority: args.authority,
      assetIndex: args.assetIndex,
      effectivePrice: step.effectivePrice,
      fundingRateE9: args.fundingRateE9 ?? 0n,
      oracleAuthority: args.oracleAuthority,
    }),
  );
}
