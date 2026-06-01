/// Friendly decode wrappers over the raw offset helpers in layout.ts, so common
/// reads (capital, pnl, positions) do not require knowing byte offsets.

export {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioPositions,
  readI128LE,
  readU128LE,
  readU64LE,
} from "./layout.ts";

import {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioPositions,
  readI128LE,
  readU128LE,
} from "./layout.ts";

export type DecodedPortfolioSummary = {
  capital: bigint;
  pnl: bigint;
  positions: ReturnType<typeof decodePortfolioPositions>;
};

/// Decode a portfolio account's capital, realized pnl, and open positions.
export function decodePortfolioSummary(data: Uint8Array): DecodedPortfolioSummary {
  return {
    capital: readU128LE(data, OFFSET_CAPITAL),
    pnl: readI128LE(data, OFFSET_PNL),
    positions: decodePortfolioPositions(data),
  };
}
