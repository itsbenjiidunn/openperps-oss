# Telegram Bot Example

A command-driven trading bot (`/market`, `/long`, `/short`, `/position`) that turns chat commands into perp trade intents, with `@opp-oss/sdk`.

This example shows how a chat bot turns commands into OpenPerps trade intents without ever holding user funds. The command logic is pure and tested, so you can wire it to any bot framework. The logic lives in `src/commands.ts`.

## What It Demonstrates

- Parse and handle `/market`, `/long`, `/short`, and `/position` commands.
- Format trade intents shared with UIs and backends.
- Keep a clear signing boundary: the bot formats an intent, the user signs and submits from their own wallet. The bot never holds user funds.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then run this example
cd examples/telegram-bot
npm install
npm test     # command parsing and handling
npm start    # pipe example messages through the bot logic
```

## How It Works

`src/commands.ts` holds the pure logic (`parseCommand` and `handleCommand`). To wire a real bot, install `node-telegram-bot-api` or `grammY` and call `handleCommand(parseCommand(msg.text), registry)` from its message handler.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your deployment. The oracle source, keeper operator, liquidity, and market registry are yours to configure.

Fork and customize it freely.

## Links

- [OpenPerps OSS](../../)
- [`@opp-oss/sdk`](../../packages/sdk/README.md)
