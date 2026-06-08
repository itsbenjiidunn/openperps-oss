# @openperps/keeper

[![npm](https://img.shields.io/npm/v/@openperps/keeper?logo=npm&label=npm)](https://www.npmjs.com/package/@openperps/keeper)
[![license](https://img.shields.io/npm/l/@openperps/keeper)](./LICENSE)

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

const connection = new Connection(process.env.OPENPERPS_RPC!, "confirmed");
const authority = Keypair.fromSecretKey(/* your oracle authority key */);

const markets: KeeperMarket[] = [
  { config: sampleMarketConfig, maxAccrualDtSlots: 1000, maxPriceMoveBpsPerSlot: 10 },
];

await runKeeper(
  { connection, authority, priceProvider: createStaticPriceProvider(100_000_000n) },
  markets,
  { intervalMs: 60_000 },
);
```

For a relayer market with no Pyth feed (custom SPL, memecoins), use
`createLivePriceProvider` from `@openperps/sdk`: it reads the token's USD price
off DexScreener then Jupiter, scales it to the market's price decimals, and holds
the last good price when both are momentarily down. Or bring your own
`PriceProvider` (Birdeye, Pyth, a pool read, Geyser, your own oracle) instead of
the static demo provider.

```ts
import { createLivePriceProvider } from "@openperps/sdk";

const priceProvider = createLivePriceProvider(); // DexScreener -> Jupiter -> last-known
```

## Run as a relayer daemon

`runKeeper` is the loop; `runRelayer` is the deployable process around it. It
defaults the price source to the live provider, derives each market's catch-up
bounds from its risk tier (`keeperMarketFromConfig`), serves `/health`, and runs
until aborted, so a MANUAL/relayer market gets a live mark pushed on-chain
without you writing any of that:

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { runRelayer, keeperMarketFromConfig } from "@openperps/keeper";

const controller = new AbortController();
await runRelayer({
  connection: new Connection(process.env.OPENPERPS_RPC!, "confirmed"),
  authority: Keypair.fromSecretKey(/* oracle authority key */),
  markets: marketConfigs.map((c) => keeperMarketFromConfig(c)),
  healthServer: { port: 18810 }, // GET /health -> 200 healthy, 503 stale/failing
  signal: controller.signal,
});
```

Or run the bundled CLI (`openperps-relayer`), configured by environment:

```bash
OPENPERPS_RPC=https://api.devnet.solana.com \
OPENPERPS_KEEPER_KEYPAIR=./keeper.json \
OPENPERPS_MARKETS=./markets.json \
npx openperps-relayer
# optional: OPENPERPS_INTERVAL_MS (60000), OPENPERPS_HEALTH_PORT (18810), OPENPERPS_HEALTH_HOST (0.0.0.0)
```

`OPENPERPS_MARKETS` is a market-config json (or array) as produced by the SDK's
`createPerpMarket`; each is validated on load. The CLI installs SIGINT/SIGTERM
handlers for a clean shutdown.

## Authority

For `AccrueAsset`, the keeper `authority` keypair must match the market's oracle
authority. If it does not, the program rejects the oracle/funding update.

By default that authority is the program's global relayer constant. A market
authority can instead rotate it per market with the SDK's `setOracleAuthorityIx`
(an `[ORACLE_SEED, market]` PDA). For such a market, set `useOracleAuthorityPda:
true` on its `KeeperMarket` so the keeper passes the PDA to `AccrueAsset`, and
run the keeper with the keypair you set as that market's oracle authority.

## Freshness

The keeper respects the engine's per-slot price-move bound and
`max_accrual_dt_slots` freshness window. When a market has fallen behind,
`buildAccrualInstructions` bursts catch-up accruals (capped per cycle) so the
asset is current before risk-increasing trades are attempted. Each `KeeperMarket`
declares both bounds via `maxAccrualDtSlots` and `maxPriceMoveBpsPerSlot`: a large
price jump is split into steps that each stay within the per-slot move budget
(`oldPrice * maxPriceMoveBpsPerSlot * dt / 10000`), so no single `AccrueAsset` is
rejected for moving the price too far too fast. See
[`../../docs/keeper-freshness.md`](../../docs/keeper-freshness.md).

## Liquidation

`discoverLiquidatable` scans the program's portfolio accounts and returns the
candidates for a market: every account with an open position in the asset, minus
the House. `liquidatePortfolio` submits a permissionless `Liquidate`, simulating
first so a healthy account (which the engine rejects) costs no transaction fee.
`scanLiquidations` runs the whole candidate set the same way and returns the
signatures that landed, so the keeper finds and clears underwater accounts on its
own. For a very large deployment, front discovery with an indexer instead of a
full `getProgramAccounts` scan.

## Monitoring

Create a `KeeperHealth` and pass it on `deps.health`; the runner records, per
market, the last crank, how many slots behind the chain it was, whether it is
stale (behind its freshness window), the last error, and a failure streak, plus
running totals. Read it live and serve it from your own endpoint:

```ts
import { createKeeperHealth, summarizeHealth, runKeeper } from "@openperps/keeper";

const health = createKeeperHealth();
void runKeeper({ connection, authority, priceProvider, health }, markets, { intervalMs: 60_000 });

// in your HTTP handler:
//   res.json({ ...summarizeHealth(health), totals: health.totals });
```

`summarizeHealth` returns `{ healthy, staleMarkets, failingMarkets }` for a
one-glance `/health` check. The pure helpers `marketBehind` and `isMarketStale`
are available if you want to compute freshness yourself.

## License

Apache-2.0.
