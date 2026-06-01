import type { OpenPerpsMarketConfig } from "./config.ts";

/// A price reading for a market. `price` is an integer in the market's
/// `priceDecimals` scale; the source string and timestamp let consumers reason
/// about freshness and provenance.
export type OpenPerpsPrice = {
  price: bigint;
  confidence?: bigint;
  slot?: number;
  source: string;
  timestampMs: number;
};

/// The interface an integrator implements to feed prices to the keeper. v1 does
/// not ship a built-in data provider: bring Birdeye, Pyth, a pool read, Geyser,
/// or your own oracle.
export type PriceProvider = {
  getPrice(market: OpenPerpsMarketConfig): Promise<OpenPerpsPrice>;
};

/// A fixed-price provider for tests and demos.
export function createStaticPriceProvider(price: bigint, source = "static"): PriceProvider {
  return {
    async getPrice() {
      return {
        price,
        source,
        timestampMs: Date.now(),
      };
    },
  };
}
