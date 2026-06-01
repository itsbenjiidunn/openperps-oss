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
