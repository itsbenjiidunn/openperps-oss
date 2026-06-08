// Off-chain pump-dump risk classifier. Suggests a market's risk tier and oracle
// posture at creation time from observable token signals (depth, FDV, realized
// volatility, age, LP lock, holder concentration, Pyth availability). It is advice
// for the integrator, the protocol only enforces the chosen tier on-chain; the
// engine is crank-forward and cannot classify the market itself. The bias is
// conservative: a token is "Stable" only with affirmative evidence of safety, and
// anything new/unknown defaults to the protective tier.

import {
  ORACLE_KIND_DEX_EWMA,
  ORACLE_KIND_MANUAL,
  ORACLE_KIND_PYTH,
  RISK_TIER_STABLE,
  RISK_TIER_VOLATILE,
} from "./layout.ts";

/** Observable signals for one token/market. All optional; a missing signal never
 * earns safety credit (it counts toward the conservative default). */
export interface MarketSignals {
  /** Quote-side depth in USD (USDC/SOL backing a sell), or depth to move ~2%. The
   * absolute liquidity available for a liquidation to execute against. */
  quoteDepthUsd?: number;
  /** Fully-diluted valuation in USD, for the liquidity/FDV ratio. */
  fdvUsd?: number;
  /** Realized volatility: the representative max % move per minute over a trailing
   * window, in bps (1000 = 10% / min). The single strongest fragility signal. */
  realizedVolBpsPerMin?: number;
  /** Token / pool age in days. */
  ageDays?: number;
  /** Percent of LP that is locked or burned (0-100). Removable LP is fake depth. */
  lpLockedPct?: number;
  /** Percent of supply held by the top 10 holders (0-100). */
  top10HolderPct?: number;
  /** Whether a Pyth pull-oracle feed exists for the token. */
  hasPythFeed?: boolean;
}

/** Tunable thresholds; the defaults are a starting heuristic, calibrate per venue. */
export interface ClassifyThresholds {
  /** Minimum absolute quote depth (USD) for adequate liquidity. */
  minQuoteDepthUsd: number;
  /** Above this absolute depth a token is treated as a major: deep enough that a
   * low liquidity/FDV ratio (inherent to large-cap tokens) is no longer a flag. */
  majorAbsDepthUsd: number;
  /** Below this liquidity/FDV ratio a NON-major token is flagged fragile. */
  minLiqFdvRatio: number;
  /** Above this realized vol a token is volatile (bps per minute). */
  maxStableVolBpsPerMin: number;
  /** Below this age (days) a token is too new to be Stable. */
  minStableAgeDays: number;
  /** Below this LP-locked percent the pool's depth is treated as unreliable. */
  minLpLockedPct: number;
  /** Above this top-10 holder percent the token is too concentrated for Stable. */
  maxTop10HolderPct: number;
}

export const DEFAULT_CLASSIFY_THRESHOLDS: ClassifyThresholds = {
  minQuoteDepthUsd: 50_000,
  majorAbsDepthUsd: 1_000_000,
  minLiqFdvRatio: 0.02,
  maxStableVolBpsPerMin: 1_000,
  minStableAgeDays: 14,
  minLpLockedPct: 80,
  maxTop10HolderPct: 60,
};

export type RiskTierName = "stable" | "volatile";
export type OraclePosture = "verifiable" | "manual";

export interface MarketClassification {
  /** Suggested risk tier name. */
  riskTier: RiskTierName;
  /** The on-chain `risk_tier` code: `RISK_TIER_STABLE` or `RISK_TIER_VOLATILE`. */
  riskTierCode: number;
  /** Whether the market can be priced by a verifiable crank or must stay relayer. */
  oraclePosture: OraclePosture;
  /** Suggested `oracle_kind`: PYTH if a feed exists, else DEX_EWMA for a real deep
   * pool, else MANUAL. */
  suggestedOracleKind: number;
  /** `low` when a primary signal (depth or realized vol) is missing. */
  confidence: "low" | "high";
  /** Human-readable drivers of the decision. */
  reasons: string[];
}

/**
 * Classify a token's pump-dump fragility into a suggested market risk tier and
 * oracle posture. Conservative by construction: Stable requires affirmative
 * evidence (low realized vol + adequate non-removable depth + maturity + not
 * concentrated); a new/unknown token defaults to Volatile + MANUAL.
 */
export function classifyMarketTier(
  signals: MarketSignals,
  thresholds: Partial<ClassifyThresholds> = {},
): MarketClassification {
  const t = { ...DEFAULT_CLASSIFY_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];

  const haveDepth = signals.quoteDepthUsd !== undefined;
  const haveVol = signals.realizedVolBpsPerMin !== undefined;
  const depthAdequate = haveDepth && signals.quoteDepthUsd! >= t.minQuoteDepthUsd;
  const isMajorDepth = haveDepth && signals.quoteDepthUsd! >= t.majorAbsDepthUsd;
  const lpOk =
    signals.lpLockedPct === undefined || signals.lpLockedPct >= t.minLpLockedPct;

  const liqFdv =
    haveDepth && signals.fdvUsd && signals.fdvUsd > 0
      ? signals.quoteDepthUsd! / signals.fdvUsd
      : undefined;
  // A low liquidity/FDV ratio only damns a non-major (large caps inherently have a
  // small ratio but ample absolute depth and low realized vol).
  const liqFdvFragile =
    liqFdv !== undefined && liqFdv < t.minLiqFdvRatio && !isMajorDepth;

  const volLow = haveVol && signals.realizedVolBpsPerMin! <= t.maxStableVolBpsPerMin;
  const mature = signals.ageDays !== undefined && signals.ageDays >= t.minStableAgeDays;
  const concentrated =
    signals.top10HolderPct !== undefined && signals.top10HolderPct > t.maxTop10HolderPct;

  // Stable only with full all-clear; otherwise the protective Volatile tier.
  const stableEligible =
    volLow && depthAdequate && !liqFdvFragile && mature && lpOk && !concentrated;
  const riskTier: RiskTierName = stableEligible ? "stable" : "volatile";

  if (stableEligible) {
    reasons.push("low realized vol, adequate depth, mature, distributed: Stable");
  } else {
    if (!haveVol) reasons.push("no volatility history: conservative default");
    else if (!volLow)
      reasons.push(`high realized vol (${signals.realizedVolBpsPerMin} bps/min)`);
    if (!haveDepth) reasons.push("quote depth unknown");
    else if (!depthAdequate)
      reasons.push(`thin quote depth ($${signals.quoteDepthUsd})`);
    if (liqFdvFragile)
      reasons.push(`low liquidity/FDV (${((liqFdv as number) * 100).toFixed(2)}%)`);
    if (!lpOk) reasons.push(`LP mostly removable (${signals.lpLockedPct}% locked)`);
    if (!mature) reasons.push(`too new (${signals.ageDays ?? "unknown"} days)`);
    if (concentrated)
      reasons.push(`concentrated holders (top 10 ${signals.top10HolderPct}%)`);
  }

  // Oracle posture: a verifiable crank needs a real, non-removable, deep pool, or a
  // Pyth feed. Otherwise the market stays MANUAL (relayer / Jupiter), which is also
  // what tracks a violent move best for a thin token.
  const deepRealPool = depthAdequate && lpOk;
  const oraclePosture: OraclePosture =
    signals.hasPythFeed || deepRealPool ? "verifiable" : "manual";
  let suggestedOracleKind = ORACLE_KIND_MANUAL;
  if (signals.hasPythFeed) {
    suggestedOracleKind = ORACLE_KIND_PYTH;
    reasons.push("has Pyth feed: verifiable (PYTH)");
  } else if (deepRealPool) {
    suggestedOracleKind = ORACLE_KIND_DEX_EWMA;
    reasons.push("deep locked pool: verifiable (DEX_EWMA)");
  } else {
    reasons.push("no Pyth and shallow/removable pool: MANUAL relayer");
  }

  return {
    riskTier,
    riskTierCode: riskTier === "volatile" ? RISK_TIER_VOLATILE : RISK_TIER_STABLE,
    oraclePosture,
    suggestedOracleKind,
    confidence: haveDepth && haveVol ? "high" : "low",
    reasons,
  };
}
