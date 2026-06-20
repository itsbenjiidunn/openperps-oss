/// Demo runner: pipe a few example messages through the command pipeline and
/// print the replies, so the bot logic runs without a Telegram token. To wire a
/// real bot, install node-telegram-bot-api (or grammY) and call
/// `handleCommand(parseCommand(msg.text), registry)` from its message handler.

import { createJsonMarketRegistry, type OpenPerpsMarketConfig } from "@opp-oss/sdk";
import { handleCommand, parseCommand } from "./commands.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "sol-devnet",
  cluster: "devnet",
  programId: "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy",
  market: "EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE",
  assetIndex: 0,
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "SOL-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "major",
  maxLeverage: 20,
  status: "active",
};

async function main(): Promise<void> {
  const registry = createJsonMarketRegistry([market]);
  const messages = [
    "/help",
    "/market sol-devnet",
    "/long sol-devnet 1000000",
    "/short sol-devnet 500000",
    "/position sol-devnet",
  ];
  for (const text of messages) {
    const reply = await handleCommand(parseCommand(text), registry);
    console.log(`> ${text}`);
    console.log(reply);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
