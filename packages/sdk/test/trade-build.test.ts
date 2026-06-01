import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

import { buildTradeFromIntent } from "../src/trade-build.ts";
import { portfolioPda } from "../src/instructions.ts";
import type { OpenPerpsMarketConfig } from "../src/config.ts";

const programId = Keypair.generate().publicKey;
const marketAccount = Keypair.generate().publicKey;
const house = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "mkt",
  cluster: "devnet",
  programId: programId.toBase58(),
  market: marketAccount.toBase58(),
  assetIndex: 0,
  baseMint: "base",
  quoteMint: "quote",
  symbol: "MKT-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "major",
  maxLeverage: 10,
  status: "active",
};

test("buildTradeFromIntent composes a PlaceOrder against the portfolio and counterparty", () => {
  const built = buildTradeFromIntent({
    intent: { schemaVersion: 1, marketId: "mkt", side: "long", size: "1000000" },
    market,
    counterparty: { housePortfolio: house.toBase58() },
    executionPrice: 100_000_000n,
    owner,
  });

  assert.equal(built.instructions.length, 1);
  const ix = built.instructions[0]!;
  assert.ok(ix instanceof TransactionInstruction);
  assert.equal(ix.programId.toBase58(), programId.toBase58());

  const [expectedPortfolio] = portfolioPda(programId, owner, marketAccount);
  assert.equal(built.userPortfolio.toBase58(), expectedPortfolio.toBase58());

  // keys: [market, userPortfolio, housePortfolio, user]
  assert.equal(ix.keys[2]!.pubkey.toBase58(), house.toBase58());
  assert.equal(ix.keys[3]!.pubkey.toBase58(), owner.toBase58());
  assert.equal(built.resolved.side, "long");
});
