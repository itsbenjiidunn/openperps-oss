import assert from "node:assert/strict";
import test from "node:test";

import { createJsonMarketRegistry, type OpenPerpsMarketConfig } from "@opp-oss/sdk";
import { handleCommand, parseCommand } from "../src/commands.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "sol-devnet",
  cluster: "devnet",
  programId: "11111111111111111111111111111111",
  market: "11111111111111111111111111111111",
  assetIndex: 0,
  baseMint: "base",
  quoteMint: "quote",
  symbol: "SOL-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "major",
  maxLeverage: 10,
  status: "active",
};
const registry = createJsonMarketRegistry([market]);

test("parses /long into a trade command", () => {
  assert.deepEqual(parseCommand("/long sol-devnet 1000000"), {
    kind: "trade",
    side: "long",
    marketId: "sol-devnet",
    size: "1000000",
  });
});

test("parses /market", () => {
  assert.deepEqual(parseCommand("/market sol-devnet"), {
    kind: "market",
    marketId: "sol-devnet",
  });
});

test("/market replies with status", async () => {
  const reply = await handleCommand(parseCommand("/market sol-devnet"), registry);
  assert.match(reply, /SOL-PERP/);
  assert.match(reply, /status=active/);
});

test("/long formats a signable trade intent", async () => {
  const reply = await handleCommand(
    parseCommand("/long sol-devnet 1000000"),
    registry,
  );
  assert.match(reply, /Sign with your wallet/i);
  assert.match(reply, /"side":"long"/);
});

test("unknown market is reported", async () => {
  const reply = await handleCommand(parseCommand("/market missing"), registry);
  assert.match(reply, /market not found/);
});
