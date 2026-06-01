/// Build the `AccrueAsset` instructions for one asset this cycle, including burst
/// catch-up when the asset has fallen behind (see freshness.ts). The keeper
/// signer must be the market's pinned oracle authority, or the program rejects
/// these.

import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { accrueAssetIx } from "@openperps/sdk";
import { planCatchUpAccruals } from "./freshness.ts";

export function buildAccrualInstructions(args: {
  programId: PublicKey;
  market: PublicKey;
  /// The oracle authority that signs the accruals.
  authority: PublicKey;
  assetIndex: number;
  /// Price to push, in the market's price scale.
  effectivePrice: bigint;
  fundingRateE9?: bigint;
  slotLast: number;
  nowSlot: number;
  maxAccrualDtSlots: number;
  maxSteps?: number;
}): TransactionInstruction[] {
  const plan = planCatchUpAccruals({
    slotLast: args.slotLast,
    nowSlot: args.nowSlot,
    maxAccrualDtSlots: args.maxAccrualDtSlots,
    maxSteps: args.maxSteps,
  });

  const instructions: TransactionInstruction[] = [];
  for (let i = 0; i < plan.steps; i++) {
    instructions.push(
      accrueAssetIx({
        programId: args.programId,
        market: args.market,
        authority: args.authority,
        assetIndex: args.assetIndex,
        effectivePrice: args.effectivePrice,
        fundingRateE9: args.fundingRateE9 ?? 0n,
      }),
    );
  }
  return instructions;
}
