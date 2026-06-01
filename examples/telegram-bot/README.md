# telegram-bot

This example shows how to integrate OpenPerps through `@openperps/sdk`.

## What It Demonstrates

- `/market`, `/long`, `/short`, `/position` commands
- trade intent formatting shared with UIs and backends
- the user signing boundary for a bot

## Run

```bash
npm install
npm test     # command parsing + handling
npm start    # pipe example messages through the bot logic
```

`src/commands.ts` is the pure logic (`parseCommand` + `handleCommand`). To wire a
real bot, install `node-telegram-bot-api` or `grammY` and call
`handleCommand(parseCommand(msg.text), registry)` from its message handler.

The signing boundary is explicit: the bot formats a trade intent, and the user
signs and submits from their own wallet. The bot never holds user funds.

## Boundaries

This example is devnet-default. It is not production-approved.
