/// node-create-market: build a custom OpenPerps market from a creation intent,
/// register it in a local JSON registry, and print the plan and addresses.
///
/// Uses a sample Solana cluster configuration. It builds and registers a market
/// locally without sending (so it runs without a funded key). To create the market
/// on-chain, fund the authority, supply a real quote mint, and send
/// `build.instructions` signed by [authority, market].

import { writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  buildMarketCreationInstructions,
  createJsonMarketRegistry,
  marketAccountSize,
  planMarketCreation,
  type OpenPerpsMarketConfig,
  type OpenPerpsMarketCreationIntent,
} from "@opp-oss/sdk";

const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.OPENPERPS_PROGRAM_ID ?? "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy",
);
const ASSET_SLOT_CAPACITY = 2;

async function main(): Promise<void> {
  // In real use, load a funded authority and a real quote (USDC) mint. This demo
  // generates throwaway keys so it runs offline-friendly (it only reads rent).
  const authority = Keypair.generate();
  const market = Keypair.generate();
  const baseMint = Keypair.generate().publicKey;
  const quoteMint = Keypair.generate().publicKey;

  const intent: OpenPerpsMarketCreationIntent = {
    schemaVersion: 1,
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    symbol: "DEMO-PERP",
    initialPrice: "1000000",
    maxLeverage: 5,
    riskTier: "experimental",
    priceProvider: { type: "external", id: "demo-feed" },
  };

  const plan = planMarketCreation(intent);
  console.log("creation plan:", plan.steps.map((s) => s.kind).join(" -> "));

  const connection = new Connection(RPC, "confirmed");
  const marketRentLamports = await connection.getMinimumBalanceForRentExemption(
    marketAccountSize(ASSET_SLOT_CAPACITY),
  );

  const build = buildMarketCreationInstructions({
    intent,
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    market: market.publicKey,
    marketRentLamports,
    assetSlotCapacity: ASSET_SLOT_CAPACITY,
  });

  console.log("market:      ", build.market.toBase58());
  console.log("vault:       ", build.vault.toBase58());
  console.log("housePortfolio:", build.housePortfolio.toBase58());
  console.log("instructions:", build.instructions.length);

  const config: OpenPerpsMarketConfig = {
    schemaVersion: 1,
    id: intent.symbol.toLowerCase(),
    cluster: "devnet",
    programId: PROGRAM_ID.toBase58(),
    market: build.market.toBase58(),
    assetIndex: 0,
    baseMint: intent.baseMint,
    quoteMint: intent.quoteMint,
    symbol: intent.symbol,
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier: intent.riskTier,
    maxLeverage: intent.maxLeverage,
    status: "draft",
  };

  const registry = createJsonMarketRegistry([config]);
  const markets = await registry.listMarkets();
  writeFileSync("registry.json", JSON.stringify(markets, null, 2));
  console.log("wrote registry.json with", markets.length, "market(s)");

  console.log(
    "\nTo create on-chain: fund the authority, use a real quote mint, then sign",
  );
  console.log("and send build.instructions with [authority, market].");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
