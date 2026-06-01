/// Keeper freshness planning. The engine bounds how far a single `AccrueAsset`
/// can advance an asset (`max_accrual_dt_slots`) and how far the price may move
/// per slot. A keeper that has fallen behind must burst several catch-up
/// accruals to clear staleness before risk-increasing trades can succeed. This
/// is the pure planning piece: given how far behind a slot is, decide how many
/// accrual steps to send.

export type AccrualPlan = {
  /// How many AccrueAsset instructions to send this cycle (always >= 1: a fresh
  /// accrual advances the asset to the current slot and price).
  steps: number;
  /// How many slots behind the current slot the asset's last accrual is.
  behindSlots: number;
};

export function planCatchUpAccruals(args: {
  slotLast: number;
  nowSlot: number;
  maxAccrualDtSlots: number;
  /// Cap on instructions per cycle so the transaction still fits. Defaults to 8.
  maxSteps?: number;
}): AccrualPlan {
  const behindSlots = Math.max(0, args.nowSlot - args.slotLast);
  const maxSteps = args.maxSteps ?? 8;
  const dt = args.maxAccrualDtSlots > 0 ? args.maxAccrualDtSlots : 1;
  const steps = Math.min(Math.max(1, Math.ceil(behindSlots / dt)), maxSteps);
  return { steps, behindSlots };
}

/// One catch-up accrual step: the effective price to push for this segment. The
/// keeper walks the price from the asset's last mark toward the target, bounding
/// each step by the engine's per-slot move budget, so no single `AccrueAsset` is
/// rejected for moving the price too far too fast.
export type AccrualStep = {
  effectivePrice: bigint;
};

/// The engine's risk-increase margin scale. A single accrual is rejected unless
/// `|dPrice| * MAX_MARGIN_BPS <= maxPriceMoveBpsPerSlot * dt * oldPrice`, so the
/// per-step budget is `oldPrice * maxPriceMoveBpsPerSlot * dt / MAX_MARGIN_BPS`.
const MAX_MARGIN_BPS = 10_000n;

/// Plan the per-step effective prices for a catch-up burst. Splits the move from
/// `oldMark` to `targetMark` across the `planCatchUpAccruals` segments, capping
/// each segment to the engine's per-slot price-move budget. The budget uses the
/// running price, so it grows as the price climbs, matching the on-chain bound
/// (which each accrual evaluates against its own prior mark). With no prior mark
/// (`oldMark <= 0`) the bound does not apply, so every step pushes the target
/// (the first accrual seeds the EWMA).
export function planAccrualSteps(args: {
  oldMark: bigint;
  targetMark: bigint;
  slotLast: number;
  nowSlot: number;
  maxAccrualDtSlots: number;
  maxPriceMoveBpsPerSlot: number;
  maxSteps?: number;
}): AccrualStep[] {
  const { steps: segmentCount, behindSlots } = planCatchUpAccruals({
    slotLast: args.slotLast,
    nowSlot: args.nowSlot,
    maxAccrualDtSlots: args.maxAccrualDtSlots,
    maxSteps: args.maxSteps,
  });

  if (args.oldMark <= 0n) {
    return Array.from({ length: segmentCount }, () => ({
      effectivePrice: args.targetMark,
    }));
  }

  const dtCap = args.maxAccrualDtSlots > 0 ? args.maxAccrualDtSlots : 1;
  const out: AccrualStep[] = [];
  let price = args.oldMark;
  let remaining = behindSlots;
  for (let i = 0; i < segmentCount; i++) {
    const dt = Math.max(1, Math.min(dtCap, remaining));
    remaining -= dt;
    const budget =
      (price * BigInt(args.maxPriceMoveBpsPerSlot) * BigInt(dt)) / MAX_MARGIN_BPS;
    const diff =
      args.targetMark > price ? args.targetMark - price : price - args.targetMark;
    const move = diff < budget ? diff : budget;
    price = args.targetMark > price ? price + move : price - move;
    out.push({ effectivePrice: price });
  }
  return out;
}
