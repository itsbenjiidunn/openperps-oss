# SDK

`@opp-oss/sdk` is the primary integration surface for OpenPerps.

It exposes two layers:

- low-level builders for instructions, PDAs, and decoders
- high-level helpers for common flows

Every send-ready helper should have a build-only equivalent so browser apps can
let wallets sign transactions themselves.

## Import

```ts
import {
  createJsonMarketRegistry,
  validateTradeIntent,
  transactionFromInstructions,
} from "@opp-oss/sdk";
```

## Integration paths

Use the SDK directly when building:

- DEX terminals
- Telegram bots
- backend scripts
- wallets
- custom launchpad flows

## Result types

High-level actions return useful result objects for bots and backends:

```ts
type PlaceTradeResult = {
  signature: string;
  marketId: string;
  side: "long" | "short";
  size: string;
  executedPrice: string;
  position?: unknown;
};

type CreateMarketResult = {
  signature: string;
  marketConfig: OpenPerpsMarketConfig;
};
```

Exact `position` typing can become stricter once decoders stabilize.
