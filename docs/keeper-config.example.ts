import type { OpenPerpsMarketConfig, PriceProvider } from "@openperps/sdk";

export const markets: OpenPerpsMarketConfig[] = [
  {
    schemaVersion: 1,
    id: "sol-devnet",
    cluster: "devnet",
    programId: "PROGRAM_ID",
    market: "MARKET_ACCOUNT",
    assetIndex: 0,
    baseMint: "BASE_MINT",
    quoteMint: "QUOTE_MINT",
    symbol: "SOL-PERP",
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier: "major",
    maxLeverage: 10,
    status: "active",
  },
];

export const priceProvider: PriceProvider = {
  async getPrice(market) {
    return {
      price: 100_000_000n,
      source: `example:${market.id}`,
      timestampMs: Date.now(),
    };
  },
};

// Market creation semantics:
// - OpenPerpsMarketCreationIntent is an SDK format, not one on-chain instruction.
// - createMarket(intent) composes a lifecycle: InitMarket -> CreateVault ->
//   CreateHouseVault -> FundHouseVault -> ActivateMarket -> optional demo
//   CreateMockPool -> oracle binding.
// - lpVault.initialDeposit must flow into the House/LP vault used as counterparty.
// - priceProvider.id is a keeper/integration identifier, not a trusted price.
// - The keeper signer must still match the market's pinned oracle authority for
//   price/funding updates.
