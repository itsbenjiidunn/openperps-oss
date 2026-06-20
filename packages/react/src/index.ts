export { useOpenPerpsTrade } from "./useOpenPerpsTrade.ts";
export type {
  PlaceTradeInput,
  UseOpenPerpsTradeResult,
} from "./useOpenPerpsTrade.ts";

export { OpenPerpsTrade } from "./OpenPerpsTrade.tsx";
export type { OpenPerpsTradeProps } from "./OpenPerpsTrade.tsx";

export { OpenPerpsPosition } from "./OpenPerpsPosition.tsx";
export type { OpenPerpsPositionProps } from "./OpenPerpsPosition.tsx";

export { OpenPerpsChart } from "./OpenPerpsChart.tsx";
export type { Candle, OpenPerpsChartProps } from "./OpenPerpsChart.tsx";

export { OpenPerpsMarketLauncher } from "./OpenPerpsMarketLauncher.tsx";
export type { OpenPerpsMarketLauncherProps } from "./OpenPerpsMarketLauncher.tsx";

// Re-export the SDK pieces an embedder needs alongside the components.
export {
  buildTradeFromIntent,
  planMarketCreation,
  resolveTradeIntent,
  portfolioPda,
  type OpenPerpsMarketConfig,
  type OpenPerpsTradeIntent,
  type OpenPerpsTradeSide,
  type OpenPerpsMarketCreationIntent,
  type TradeCounterparty,
} from "@opp-oss/sdk";
