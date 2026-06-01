/// SDK-side trade resolution. These are pure functions, no RPC and no sending.
/// They turn an `OpenPerpsTradeIntent` plus resolved market state into a checked
/// `ResolvedTrade`, enforcing the v1 SDK-side guards.
///
/// Model:
/// - Official markets trade against the configured shared House/LP portfolio.
/// - Custom markets trade against the creator/integrator House/LP portfolio.
/// - Execution price comes from keeper-certified/on-chain mark state. Client and
///   chart prices are display/prefill only and must not be passed here as the
///   execution price.
/// - `limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK guards, not native
///   on-chain orderbook semantics.
/// - `maxLeverage` is SDK/UI risk policy metadata, not a native engine field.

import type { OpenPerpsMarketConfig } from "./config.ts";
import type { OpenPerpsTradeIntent, OpenPerpsTradeSide } from "./intents.ts";

/// The portfolio that takes the other side of a user trade.
export type TradeCounterparty = {
  housePortfolio: string;
};

/// The user's current position in a market, used for `reduceOnly` checks.
export type CurrentPosition = {
  side: OpenPerpsTradeSide;
  size: string;
};

export type ResolveTradeInput = {
  intent: OpenPerpsTradeIntent;
  market: OpenPerpsMarketConfig;
  /// The House/LP portfolio. Official markets pass the shared House; custom
  /// markets pass the creator's House. Required: with no counterparty the SDK
  /// must fail before building a transaction.
  counterparty?: TradeCounterparty;
  /// Execution price from keeper-certified/on-chain mark state, in the market's
  /// `priceDecimals` scale. Never a client/chart price.
  executionPrice: bigint;
  /// The reference price the user saw, for slippage. Defaults to executionPrice.
  referencePrice?: bigint;
  /// The user's current position, for `reduceOnly`.
  position?: CurrentPosition;
};

export type ResolvedTrade = {
  marketId: string;
  side: OpenPerpsTradeSide;
  size: string;
  housePortfolio: string;
  executionPrice: bigint;
};

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function resolveTradeIntent(input: ResolveTradeInput): ResolvedTrade {
  const { intent, market, counterparty, executionPrice } = input;

  if (intent.marketId !== market.id) {
    throw new Error(
      `trade intent marketId ${intent.marketId} does not match market ${market.id}`,
    );
  }

  if (!counterparty || counterparty.housePortfolio.length === 0) {
    throw new Error(`no House/LP counterparty configured for market ${market.id}`);
  }

  if (intent.limitPrice !== undefined) {
    const limit = BigInt(intent.limitPrice);
    if (intent.side === "long" && executionPrice > limit) {
      throw new Error(
        `execution price ${executionPrice} exceeds long limitPrice ${limit}`,
      );
    }
    if (intent.side === "short" && executionPrice < limit) {
      throw new Error(
        `execution price ${executionPrice} is below short limitPrice ${limit}`,
      );
    }
  }

  if (intent.maxSlippageBps !== undefined) {
    const ref = input.referencePrice ?? executionPrice;
    const denom = ref === 0n ? 1n : ref;
    const slippageBps = (absDiff(executionPrice, ref) * 10_000n) / denom;
    if (slippageBps > BigInt(intent.maxSlippageBps)) {
      throw new Error(
        `slippage ${slippageBps} bps exceeds maxSlippageBps ${intent.maxSlippageBps}`,
      );
    }
  }

  if (intent.reduceOnly) {
    const pos = input.position;
    // A reduce-only order must not open or grow exposure: the user must already
    // hold a position on the opposite side of the order.
    if (!pos || pos.side === intent.side) {
      throw new Error("reduceOnly trade would open or increase exposure");
    }
  }

  return {
    marketId: market.id,
    side: intent.side,
    size: intent.size,
    housePortfolio: counterparty.housePortfolio,
    executionPrice,
  };
}
