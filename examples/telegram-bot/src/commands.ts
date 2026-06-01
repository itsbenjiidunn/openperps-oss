/// Command parsing and handling for a Telegram trading bot. Pure functions over
/// a market registry: the bot front-end (node-telegram-bot-api or grammY) just
/// pipes message text in and sends the reply out.
///
/// The signing boundary is explicit: the bot formats a trade intent, but the
/// user signs and submits from their own wallet. The bot never holds user funds.

import {
  validateTradeIntent,
  type MarketRegistryProvider,
  type OpenPerpsTradeIntent,
} from "@openperps/sdk";

export type Command =
  | { kind: "help" }
  | { kind: "market"; marketId: string }
  | { kind: "trade"; side: "long" | "short"; marketId: string; size: string }
  | { kind: "position"; marketId: string }
  | { kind: "unknown"; text: string };

export function parseCommand(text: string): Command {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  switch (cmd) {
    case "/start":
    case "/help":
      return { kind: "help" };
    case "/market":
      return parts[1] ? { kind: "market", marketId: parts[1] } : { kind: "help" };
    case "/long":
    case "/short":
      return parts[1] && parts[2]
        ? {
            kind: "trade",
            side: cmd === "/long" ? "long" : "short",
            marketId: parts[1],
            size: parts[2],
          }
        : { kind: "help" };
    case "/position":
      return parts[1] ? { kind: "position", marketId: parts[1] } : { kind: "help" };
    default:
      return { kind: "unknown", text };
  }
}

const HELP = [
  "OpenPerps bot commands:",
  "/market <id>          market status",
  "/long <id> <size>     format a long intent",
  "/short <id> <size>    format a short intent",
  "/position <id>        your position (connect wallet)",
].join("\n");

export async function handleCommand(
  cmd: Command,
  registry: MarketRegistryProvider,
): Promise<string> {
  switch (cmd.kind) {
    case "help":
      return HELP;
    case "market": {
      const m = await registry.getMarket(cmd.marketId);
      return m
        ? `${m.symbol} (${m.cluster}) status=${m.status} maxLeverage=${m.maxLeverage}x`
        : `market not found: ${cmd.marketId}`;
    }
    case "trade": {
      const m = await registry.getMarket(cmd.marketId);
      if (!m) return `market not found: ${cmd.marketId}`;
      const intent: OpenPerpsTradeIntent = validateTradeIntent({
        schemaVersion: 1,
        marketId: cmd.marketId,
        side: cmd.side,
        size: cmd.size,
      });
      return [
        `Trade intent ready for ${m.symbol}. Sign with your wallet to submit:`,
        JSON.stringify(intent),
      ].join("\n");
    }
    case "position":
      return `Connect a wallet to view your position in ${cmd.marketId}.`;
    case "unknown":
      return "Unknown command. Try /help.";
  }
}
