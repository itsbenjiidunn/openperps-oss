# Telegram Bot Example

[![OpenPerps OSS](https://img.shields.io/badge/OpenPerps-OSS-9945FF)](https://github.com/itsbenjiidunn/openperps-oss)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE)

> A command-driven trading bot (`/market`, `/long`, `/short`, `/position`) with an
> explicit signing boundary, built on `@openperps/sdk`.

This example shows how a chat bot turns commands into OpenPerps trade intents
without ever holding user funds. The command logic is pure and tested, so you can
wire it to any bot framework. The logic lives in
[`src/commands.ts`](src/commands.ts).

<!-- Add a short terminal recording of the example messages and replies here, for
     example ../../.github/assets/telegram-bot-demo.gif -->

## What it demonstrates

- `/market`, `/long`, `/short`, and `/position` commands.
- Trade-intent formatting shared with UIs and backends.
- The signing boundary: the bot formats an intent, the user signs and submits from
  their own wallet. The bot never holds user funds.

## Run

```bash
# from the repo root, build the workspace packages once
npm install
npm run build

# then run this example
cd examples/telegram-bot
npm install
npm test     # command parsing + handling
npm start    # pipe example messages through the bot logic
```

## How it works

`src/commands.ts` is the pure logic (`parseCommand` + `handleCommand`). To wire a
real bot, install `node-telegram-bot-api` or `grammY` and call
`handleCommand(parseCommand(msg.text), registry)` from its message handler.

## Boundaries

This example uses sample Solana cluster configuration and can be adapted for your
deployment. The oracle source, keeper operator, liquidity, and market registry are
yours to configure. Fork and customize it freely.

## Links

- [OpenPerps OSS](../../) (main repo)
- [`@openperps/sdk`](../../packages/sdk/README.md)
