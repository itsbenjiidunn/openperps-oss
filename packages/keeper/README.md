# @openperps/keeper

The core-only self-host keeper for OpenPerps. A keeper is part of the risk
system, not just a price cron: it pushes oracle/funding updates on-chain and
submits liquidations across many markets.

v1 scope is intentionally small. It does not include analytics, candles,
billing, a hosted tenant registry, a trade feed API, or an SLA system.

## Use

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { createStaticPriceProvider } from "@openperps/sdk";
import { runKeeper, type KeeperMarket } from "@openperps/keeper";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const authority = Keypair.fromSecretKey(/* your oracle authority key */);

const markets: KeeperMarket[] = [
  { config: solDevnetConfig, maxAccrualDtSlots: 1000 },
];

await runKeeper(
  { connection, authority, priceProvider: createStaticPriceProvider(100_000_000n) },
  markets,
  { intervalMs: 60_000 },
);
```

Bring your own `PriceProvider` (Birdeye, Pyth, a pool read, Geyser, or your own
oracle) instead of the static demo provider.

## Authority

For `AccrueAsset`, the keeper `authority` keypair must match the market's pinned
oracle authority. If it does not, the program rejects the oracle/funding update.

## Freshness

The keeper respects the engine's per-slot price-move bound and
`max_accrual_dt_slots` freshness window. When a market has fallen behind,
`buildAccrualInstructions` bursts catch-up accruals (capped per cycle) so the
asset is current before risk-increasing trades are attempted. See
[`../../docs/keeper-freshness.md`](../../docs/keeper-freshness.md).

## Liquidation

`liquidatePortfolio` submits a permissionless `Liquidate` for a candidate
portfolio; the engine rejects a healthy account, so it is safe to attempt.
Discovering which portfolios are unhealthy is integrator-provided in v1.

## License

Apache-2.0.
