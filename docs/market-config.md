# Market Config

`OpenPerpsMarketConfig` is the portable description of a market, rich enough for
launchpads, bots, DEX terminals, and wallets. It carries `schemaVersion` from v1
so external registries and cached configs can evolve safely.

```ts
type OpenPerpsMarketConfig = {
  schemaVersion: 1;
  id: string;
  cluster: "devnet" | "mainnet-beta";
  programId: string;
  market: string;
  assetIndex: number;
  baseMint: string;
  quoteMint: string;
  symbol: string;
  name?: string;
  priceDecimals: number;
  sizeDecimals: number;
  quoteDecimals: number;
  poolAddress?: string;
  dex?: string;
  createdBy?: string;
  riskTier: "major" | "standard" | "experimental";
  maxLeverage: number;
  status: "draft" | "active" | "paused" | "close-only" | "settled";
  keeper?: { oracleAuthority?: string; expectedCrankIntervalMs?: number };
  metadata?: { logoURI?: string; website?: string; tags?: string[] };
};
```

`status` is advisory off-chain metadata. It does not by itself pause or
close-only a market on-chain. On-chain state is still enforced by the program's
market mode and instruction guards, so if an integrator marks a market `paused`
or `close-only`, their own frontend, bot, keeper, or relayer must enforce that
policy.

`maxLeverage` is SDK/UI risk metadata. The engine enforces margin and risk
constraints, but it does not have a native config field named `maxLeverage`.

`priceDecimals`, `sizeDecimals`, and `quoteDecimals` are display/conversion
metadata. The engine uses fixed internal scales; SDK helpers convert user-facing
units into engine atoms.
