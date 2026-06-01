# @openperps/sdk

The core TypeScript client for [OpenPerps](https://github.com/itsbenjiidunn/openperps-oss),
the open-source perpetual-futures layer for Solana apps. It hides PDAs,
instruction tags, account layouts, and atom/price math behind small, typed
functions so a web app, a backend, or a bot all share the same power.

> Devnet by default. Mainnet-capable, not production-approved. OpenPerps v1 is
> unaudited; do not use with real user funds without your own review.

## Install

```bash
npm install @openperps/sdk @solana/web3.js @solana/spl-token
```

`@solana/web3.js` and `@solana/spl-token` are peer dependencies, so the SDK
shares the host app's single instance of each.

## What it does

- **Trade build and resolution.** `resolveTrade` checks an intent against the
  market and on-chain mark (size, side, reduce-only, slippage); `buildTradeFromIntent`
  composes the on-chain instructions against the user's portfolio and the House
  counterparty.
- **Market creation.** `planMarketCreation` and the build helpers compose the
  full lifecycle (market account, vault, House, oracle binding) for a custom
  market on any token.
- **Account decoders.** `decodePortfolioSummary`, `decodePortfolioPositions`,
  and the layout offsets read market, portfolio, and position state.
- **Price providers.** Bring your own `PriceProvider` (Pyth, a pool read, your
  own oracle) or use `createStaticPriceProvider` for tests and demos.
- **Instruction encoders.** Low-level `accrueAssetIx`, `liquidateIx`, and the
  rest, mirroring the Rust program, for when you need to compose by hand.

## Quick start

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { buildTradeFromIntent, transactionFromInstructions } from "@openperps/sdk";

const built = buildTradeFromIntent({
  intent: { schemaVersion: 1, marketId: market.id, side: "long", size: "1000000" },
  market,                 // OpenPerpsMarketConfig
  counterparty,           // resolved House / LP portfolio
  executionPrice,         // bigint, from the keeper / on-chain mark
  owner: wallet.publicKey,
});

const tx = transactionFromInstructions(built.instructions, { feePayer: wallet.publicKey });
// sign + send with your wallet adapter
```

For a turnkey React widget over this flow, see
[`@openperps/react`](https://www.npmjs.com/package/@openperps/react). To run the
oracle crank and liquidations, see
[`@openperps/keeper`](https://www.npmjs.com/package/@openperps/keeper).

## License

Apache-2.0. Built on [Percolator](https://github.com/aeyakovenko/percolator) v16
by Anatoly Yakovenko (@toly).
