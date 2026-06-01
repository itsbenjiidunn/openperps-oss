/// SDK-side market creation planning. Pure functions, no RPC and no sending in
/// v1. `OpenPerpsMarketCreationIntent` is an SDK format, not one on-chain
/// instruction: creating a usable custom market is a composed lifecycle. This
/// module turns an intent into an ordered, inspectable creation plan.

import type { OpenPerpsMarketCreationIntent } from "./intents.ts";

export type MarketCreationStep =
  | { kind: "InitMarket"; baseMint: string; quoteMint: string; symbol: string }
  | { kind: "CreateVault" }
  | { kind: "CreateHouseVault" }
  | { kind: "FundHouseVault"; amount: string }
  | { kind: "ActivateMarket"; initialPrice: string }
  | { kind: "CreateMockPool" };

export type OracleBinding = {
  /// The integrator/keeper identifier from the intent. It is NOT a trusted price
  /// by itself; the keeper signer must still satisfy the program's oracle
  /// authority checks.
  priceProviderId: string;
  description?: string;
};

export type MarketCreationPlan = {
  steps: MarketCreationStep[];
  oracleBinding: OracleBinding;
};

export type PlanMarketCreationOptions = {
  /// Include a devnet mock pool step for demo price sources. Off by default.
  includeMockPool?: boolean;
};

/// Build the ordered creation plan for a custom market:
/// InitMarket -> CreateVault -> CreateHouseVault -> (FundHouseVault if
/// lpVault.initialDeposit) -> ActivateMarket -> (CreateMockPool if requested),
/// plus the oracle binding metadata.
export function planMarketCreation(
  intent: OpenPerpsMarketCreationIntent,
  options: PlanMarketCreationOptions = {},
): MarketCreationPlan {
  const steps: MarketCreationStep[] = [
    {
      kind: "InitMarket",
      baseMint: intent.baseMint,
      quoteMint: intent.quoteMint,
      symbol: intent.symbol,
    },
    { kind: "CreateVault" },
    { kind: "CreateHouseVault" },
  ];

  const initialDeposit = intent.lpVault?.initialDeposit;
  if (initialDeposit !== undefined) {
    steps.push({ kind: "FundHouseVault", amount: initialDeposit });
  }

  steps.push({ kind: "ActivateMarket", initialPrice: intent.initialPrice });

  if (options.includeMockPool) {
    steps.push({ kind: "CreateMockPool" });
  }

  const oracleBinding: OracleBinding = {
    priceProviderId: intent.priceProvider.id,
  };
  if (intent.priceProvider.description !== undefined) {
    oracleBinding.description = intent.priceProvider.description;
  }

  return { steps, oracleBinding };
}
