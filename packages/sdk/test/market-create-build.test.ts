import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import { buildMarketCreationInstructions } from "../src/market-create-build.ts";
import { HOUSE_SEED, VAULT_SEED } from "../src/layout.ts";
import type { OpenPerpsMarketCreationIntent } from "../src/intents.ts";

const programId = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const quoteToken = Keypair.generate().publicKey;

function intentWith(
  patch: Partial<OpenPerpsMarketCreationIntent> = {},
): OpenPerpsMarketCreationIntent {
  return {
    schemaVersion: 1,
    baseMint: Keypair.generate().publicKey.toBase58(),
    quoteMint: Keypair.generate().publicKey.toBase58(),
    symbol: "TEST-PERP",
    initialPrice: "1000000",
    maxLeverage: 5,
    riskTier: "experimental",
    priceProvider: { type: "external", id: "feed" },
    ...patch,
  };
}

test("composes the core creation instructions and derives vault/house PDAs", () => {
  const build = buildMarketCreationInstructions({
    intent: intentWith(),
    programId,
    authority,
    market,
    marketRentLamports: 1_000_000,
    assetSlotCapacity: 2,
  });

  // createAccount, InitMarket, CreateVault, CreateHouseVault, ActivateMarket
  assert.equal(build.instructions.length, 5);

  const [vault] = PublicKey.findProgramAddressSync([VAULT_SEED, market.toBuffer()], programId);
  const [house] = PublicKey.findProgramAddressSync([HOUSE_SEED, market.toBuffer()], programId);
  assert.equal(build.vault.toBase58(), vault.toBase58());
  assert.equal(build.housePortfolio.toBase58(), house.toBase58());
  assert.equal(build.marketGroupId.length, 32);
});

test("includes FundHouseVault when an initial deposit is provided", () => {
  const build = buildMarketCreationInstructions({
    intent: intentWith({ lpVault: { initialDeposit: "50000000" } }),
    programId,
    authority,
    market,
    marketRentLamports: 1_000_000,
    assetSlotCapacity: 2,
    authorityQuoteToken: quoteToken,
  });
  assert.equal(build.instructions.length, 6);
});

test("requires authorityQuoteToken when funding the House", () => {
  assert.throws(
    () =>
      buildMarketCreationInstructions({
        intent: intentWith({ lpVault: { initialDeposit: "50000000" } }),
        programId,
        authority,
        market,
        marketRentLamports: 1_000_000,
        assetSlotCapacity: 2,
      }),
    /authorityQuoteToken is required/i,
  );
});
