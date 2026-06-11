/// Economic model of the House / HLP on a perp market, used to answer the only
/// question the on-chain mechanics cannot: does the House (and so its LPs) survive
/// and earn on real flow, or is it a bounded-loss backstop? It is a simulation,
/// not a 1:1 mirror of the engine, but it is faithful to the actual P&L drivers
/// verified in the program:
///
///   * The House is the counterparty to every user trade (B-book). Its NET signed
///     position per asset equals the user imbalance, bounded by `SetHouseCap`.
///   * Income: skew funding only. The House is always the thin side (the residual
///     counterparty), so it always RECEIVES funding. The rate is the on-chain
///     `skew_funding_rate_e9`, capped at `ORACLE_FUNDING_MAX_E9 = 10` e9/slot,
///     i.e. ~0.2%/day at full imbalance -- tiny next to a memecoin's moves.
///   * Cost 1: inventory mark-to-market. Net short a pumping token loses
///     position x dPrice, realized when the longs close at the top.
///   * Cost 2: the trading fee. The engine charges BOTH sides and routes it to
///     insurance, so the House PAYS its leg's fee (it does not earn it). The fee
///     floor (`SetMarketFee`) raises this cost, not House income.
///
/// The optional `feeToHouseBps` knob models a counterfactual the current engine
/// does NOT implement: the House earning a maker fee/spread. It is here precisely
/// to quantify how much that would change viability.

/** On-chain skew-funding cap: max |rate| in e9 per slot (`ORACLE_FUNDING_MAX_E9`). */
export const FUNDING_MAX_E9 = 10;
/** Funding rates are stored scaled by 1e9. */
export const E9 = 1e9;
/** Solana slot time (s) and derived slots/day, to annualize. */
export const SLOT_SECONDS = 0.4;
export const SLOTS_PER_DAY = 86_400 / SLOT_SECONDS; // 216_000

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/// Mirror of the program's `skew_funding_rate_e9`: signed e9/slot rate from the
/// House net position and the cap (the saturation reference). House net SHORT
/// (negative) gives a POSITIVE rate so longs pay the short House; saturates at
/// +/-`FUNDING_MAX_E9` once |houseNet| >= refOi.
export function skewFundingRateE9(houseNet: number, refOi: number): number {
  if (refOi <= 0) return 0;
  const scaled = (houseNet * FUNDING_MAX_E9) / refOi;
  const rate = clamp(-scaled, -FUNDING_MAX_E9, FUNDING_MAX_E9);
  return rate === 0 ? 0 : rate; // normalize -0 -> 0

}

export type MarketParams = {
  /// `SetHouseCap`: max net House position per asset (base units). Bounds the
  /// inventory loss from any one move.
  houseCapBase: number;
  /// Trading fee floor (bps). The House PAYS this on its own leg (cost).
  feeBps: number;
  /// Counterfactual: a maker fee (bps) the House EARNS on traded notional. 0 in
  /// the current engine; raise it to see what fee-to-House would buy.
  feeToHouseBps?: number;
  /// House seed capital (quote units, e.g. USD).
  houseCapital: number;
};

/// One step of the market: the oracle mark, the NET new user long opened this step
/// (base units; the House takes the opposite, clamped by the cap), and elapsed
/// slots. A close is a negative `userNetLongDelta`.
export type Step = {
  price: number;
  userNetLongDelta: number;
  dtSlots: number;
};

export type SimResult = {
  /// House equity at the end (quote). Above `houseCapital` = the House earned.
  finalEquity: number;
  /// Lowest equity reached (the drawdown that an LP feels / the seed-blow risk).
  minEquity: number;
  /// Cumulative components.
  fundingIncome: number;
  inventoryPnl: number;
  feesPaid: number;
  feesEarned: number;
  /// House net position at the end (base, signed).
  endHouseNet: number;
  /// Equity went non-positive at some point (the seed was blown through).
  brokeSeed: boolean;
  /// Return on the seed over the path (finalEquity/houseCapital - 1).
  returnOnSeed: number;
};

/// Run the House through a price + flow path and return its P&L decomposition.
export function simulate(params: MarketParams, path: Step[]): SimResult {
  const feeToHouseBps = params.feeToHouseBps ?? 0;
  let houseNet = 0; // signed base units; negative = short
  let equity = params.houseCapital;
  let minEquity = equity;
  let funding = 0;
  let inventory = 0;
  let feesPaid = 0;
  let feesEarned = 0;
  let prevPrice = path.length > 0 ? path[0]!.price : 0;

  for (const step of path) {
    // 1. Inventory mark-to-market on the existing net over the price move. A net
    //    long (+) gains when price rises; a net short (-) loses.
    const dP = step.price - prevPrice;
    const invStep = houseNet * dP;

    // 2. New flow: the House takes -userNetLongDelta, clamped to the cap (trades
    //    past the cap are rejected on-chain, so the House simply does not fill them).
    const desiredNet = houseNet - step.userNetLongDelta;
    const clampedNet = clamp(desiredNet, -params.houseCapBase, params.houseCapBase);
    const filledBase = Math.abs(clampedNet - houseNet);
    houseNet = clampedNet;

    // 3. Fees on the filled leg: the House pays its own (cost), and -- only in the
    //    counterfactual -- earns a maker fee.
    const filledNotional = filledBase * step.price;
    const feePaidStep = filledNotional * (params.feeBps / 1e4);
    const feeEarnStep = filledNotional * (feeToHouseBps / 1e4);

    // 4. Funding: the House is the thin side, so it always receives. Magnitude is
    //    |net| notional x (rate/1e9) x slots.
    const rateE9 = skewFundingRateE9(houseNet, params.houseCapBase);
    const fundStep = -houseNet * step.price * (rateE9 / E9) * step.dtSlots;

    funding += fundStep;
    inventory += invStep;
    feesPaid += feePaidStep;
    feesEarned += feeEarnStep;
    equity += invStep + fundStep - feePaidStep + feeEarnStep;
    minEquity = Math.min(minEquity, equity);
    prevPrice = step.price;
  }

  return {
    finalEquity: equity,
    minEquity,
    fundingIncome: funding,
    inventoryPnl: inventory,
    feesPaid,
    feesEarned,
    endHouseNet: houseNet,
    brokeSeed: minEquity <= 0,
    returnOnSeed: params.houseCapital > 0 ? equity / params.houseCapital - 1 : 0,
  };
}
