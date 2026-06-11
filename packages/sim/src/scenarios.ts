/// Canonical memecoin flow scenarios as `Step[]` paths for the House simulator.
/// Each models a way real one-sided / two-sided flow hits the House.

import type { Step } from "./economics.ts";

/// Geometric price series of `n` prices from `p0` to `pEnd` (inclusive ends).
export function geomPrices(p0: number, pEnd: number, n: number): number[] {
  if (n <= 1) return [pEnd];
  const r = (pEnd / p0) ** (1 / (n - 1));
  return Array.from({ length: n }, (_, i) => p0 * r ** i);
}

/// Balanced two-sided churn: the price drifts mildly, and equal long/short flow
/// arrives each step, so the House's net stays near flat. The honest "no
/// directional bet" baseline -- what's left is funding minus the fee the House pays.
export function balancedChurn(opts: {
  price?: number;
  perStepFlow?: number; // base units opened each side per step
  steps?: number;
  dtSlots?: number;
}): Step[] {
  const price = opts.price ?? 1;
  const flow = opts.perStepFlow ?? 1_000;
  const steps = opts.steps ?? 200;
  const dtSlots = opts.dtSlots ?? 50;
  // Alternate +flow / -flow net deltas so the book oscillates around flat.
  return Array.from({ length: steps }, (_, i) => ({
    price,
    userNetLongDelta: i % 2 === 0 ? flow : -flow,
    dtSlots,
  }));
}

/// Sustained one-sided pump, users HOLD: a block of net long opens at the bottom,
/// then the price climbs from `p0` to `pEnd` over many slots while users stay in.
/// Funding accrues over the long hold; inventory loss grows with the price.
export function sustainedPumpHold(opts: {
  p0?: number;
  pEnd?: number;
  size?: number; // base units of net long opened up front
  steps?: number;
  dtSlots?: number;
}): Step[] {
  const p0 = opts.p0 ?? 1;
  const pEnd = opts.pEnd ?? 3; // 3x over the window
  const size = opts.size ?? 100_000;
  const steps = opts.steps ?? 200;
  const dtSlots = opts.dtSlots ?? 1_000; // long, sustained -> ~lots of slots
  const prices = geomPrices(p0, pEnd, steps);
  return prices.map((price, i) => ({
    price,
    userNetLongDelta: i === 0 ? size : 0, // open up front, then hold
    dtSlots,
  }));
}

/// Fast pump + exit (the adverse-selection killer): users open net long at the
/// bottom, the price spikes to `pEnd` in only a few slots, then users CLOSE at the
/// top -- realizing their gain out of the House. Funding has no time to accrue.
export function fastPumpExit(opts: {
  p0?: number;
  pEnd?: number;
  size?: number;
  rampSteps?: number;
  dtSlots?: number;
}): Step[] {
  const p0 = opts.p0 ?? 1;
  const pEnd = opts.pEnd ?? 2; // doubles
  const size = opts.size ?? 100_000;
  const rampSteps = opts.rampSteps ?? 10; // few, fast
  const dtSlots = opts.dtSlots ?? 5; // seconds, not minutes
  const prices = geomPrices(p0, pEnd, rampSteps);
  const path: Step[] = prices.map((price, i) => ({
    price,
    userNetLongDelta: i === 0 ? size : 0,
    dtSlots,
  }));
  // Users close the whole position at the top: House net returns to ~flat, the
  // loss already realized on the way up.
  path.push({ price: pEnd, userNetLongDelta: -size, dtSlots });
  return path;
}
