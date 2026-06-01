# OpenPerps OSS SDK-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OpenPerps into an SDK-first open-source perp layer for Solana apps, with clear public SDK APIs, reusable market config/intents, core keeper boundaries, React integration surface, and examples for multiple trading surfaces.

**Architecture:** Keep the existing on-chain program and current `ts/sdk` package in place. Add public SDK modules around the existing low-level instruction/layout files first, then update docs and examples to use those APIs. Do not start with a repo-wide move; package boundaries come before folder reshuffling.

**Tech Stack:** TypeScript 5.6, `@solana/web3.js`, `@solana/spl-token`, existing `ts/sdk`, Vite/React for examples/widgets, Node/tsx for scripts, existing Pinocchio/Solana program.

---

## OpenPerps OSS And OpenPerps App

OpenPerps has two layers:

1. OpenPerps OSS
   The open-source perp layer: program, SDK, keeper, React components, examples, docs.

2. OpenPerps App
   The existing perp trading application built on top of OpenPerps OSS.

During extraction, the current repo is the source codebase that contains both app code and reusable infrastructure. The OSS work extracts reusable pieces into `D:\Working\openperps-oss`.

After extraction, OpenPerps App should consume OpenPerps OSS packages instead of keeping private copies of reusable primitives.

Rule:

> Generic reusable code goes to OpenPerps OSS.
> Product/app-specific code stays in OpenPerps App.

Move to OpenPerps OSS:

- program
- SDK
- account decoders
- intent types
- market config
- keeper core
- generic React widgets
- examples
- docs

Stay in OpenPerps App:

- app routes
- brand-specific UI
- hosted config
- curated market pages
- product copy
- product analytics
- deployment/domain setup

Positioning line:

> OpenPerps App is the first application built on OpenPerps OSS.

Do not call OpenPerps App a "PerpDEX".

## Scope Notes

The approved spec is `docs/superpowers/specs/2026-06-01-openperps-oss-sdk-first-design.md`.

This plan intentionally starts with SDK and docs. It does not attempt to rewrite the Solana program, move the whole repo into `packages/`, or build hosted/KaaS.

Execution workspace for the OSS split: `D:\Working\openperps-oss`. Treat `C:\Users\Admin\openperps` as the source project until the OSS folder is created/copied. Do not perform the open-source restructuring directly in the source repo unless explicitly requested.

Resolved blocker: `crates/program/src/state.rs` now avoids nested `core::mem::offset_of!` by summing offsets at each level. `cargo test -p openperps-program` was verified on 2026-06-01: 24 unit tests and 29 integration tests passed. Keep this verification in the final pass.

## Target File Structure

Create or modify these files first:

```txt
ts/sdk/src/config.ts              # market config, registry provider, validation
ts/sdk/src/intents.ts             # trade intent and market creation intent
ts/sdk/src/transactions.ts        # build-only tx helpers
ts/sdk/src/actions.ts             # send-ready high-level actions
ts/sdk/src/decoders.ts            # friendly decode wrappers around layout.ts
ts/sdk/src/price.ts               # PriceProvider interface and price result type
ts/sdk/src/index.ts               # public SDK exports
ts/sdk/test/*.test.ts             # SDK unit tests
ts/sdk/package.json               # add test script if missing

docs/sdk.md
docs/quickstart.md
docs/market-config.md
docs/trade-intent.md
docs/market-creation-intent.md
docs/keeper.md
docs/keeper-freshness.md
docs/react-components.md
docs/examples.md
docs/permissions.md
docs/oracle-and-price-safety.md
docs/security-and-limitations.md

examples/node-create-market/
examples/launchpad/
examples/dex-terminal/
examples/token-page/
examples/wallet-position-card/
examples/telegram-bot/
```

Later, after SDK APIs stabilize:

```txt
packages/react/                  # optional extraction target
packages/keeper/                 # optional extraction target
apps/demo/                       # optional rename/extraction target for existing frontend
```

## Task 0: Re-vendor And Verify Engine v16.8.5 Baseline

**Files:**
- Modify: `crates/engine/src/v16.rs`
- Modify: `crates/engine/spec.md`
- Modify: `crates/program/src/state.rs`
- Modify: `crates/program/src/processor.rs`
- Modify: `crates/program/tests/init_deposit.rs`
- Modify: `ts/sdk/src/instructions.ts`
- Modify: `NOTICE`
- Create: `docs/engine-upstream.md`

- [ ] **Step 1: Verify current repo is not already at the target baseline**

Run:

```powershell
Select-String -Path crates\program\src\state.rs -Pattern "settle_realized_pnl_not_atomic|convert_released_pnl_to_capital" -Context 2,3
```

Expected before this task: current repo still shows `settle_realized_pnl_not_atomic`. Do not record baseline as current until the re-vendor/adaptation steps below are complete.

- [ ] **Step 2: Re-vendor engine files from upstream**

Bring `crates/engine` back to the pinned upstream baseline:

```txt
upstream: aeyakovenko/percolator
engine generation: v16.8.5
pinned source commit: 7188eece
```

Copy the upstream engine files for that SHA into `crates/engine`, then inspect the diff. The expected outcome is that `crates/engine/src/v16.rs` no longer carries untracked local drift beyond documented wrapper integration requirements.

- [ ] **Step 3: Adapt SettlePnl to the v16.8.5 released-PnL flow**

Modify `crates/program/src/state.rs`:

```txt
settle_pnl_buffer should use the v16.8.5 released-PnL conversion path:
convert_released_pnl_to_capital

It should not keep using:
settle_realized_pnl_not_atomic(&mut user, &mut house)
```

Modify `crates/program/src/processor.rs`:

```txt
SettlePnl should no longer require the House portfolio account when the engine flow converts the user's released PnL into capital directly.

Remove House-specific account validation from process_settle_pnl after confirming the new engine method does not require House.
```

Modify `ts/sdk/src/instructions.ts`:

```txt
settlePnlIx account list must match the updated on-chain SettlePnl handler.
If the House account is removed from the handler, remove it from settlePnlIx as well.
```

Update tests that construct `SettlePnl` instructions so account lists match the new handler.

- [ ] **Step 4: Verify layout print test**

Run:

```powershell
cargo test -p openperps-program print_byte_sizes_for_sdk -- --nocapture
```

Expected: PASS. Confirm printed offsets still match `ts/sdk/src/layout.ts`. If offsets changed, update `layout.ts` and the related decoder tests in the same commit.

- [ ] **Step 5: Verify program tests**

Run:

```powershell
cargo test -p openperps-program
```

Expected after the re-vendor/adaptation: PASS with 24 unit tests and 29 integration tests. If the test count changes because tests are added, record the new count in this plan/doc update.

- [ ] **Step 6: Record upstream baseline**

Create `docs/engine-upstream.md`:

```md
# Engine Upstream Baseline

OpenPerps vendors the percolator v16 risk engine as its core risk engine baseline.

Current baseline:

- upstream: aeyakovenko/percolator
- engine generation: v16.8.5
- pinned source commit: 7188eece

Wrapper-specific adaptations must be documented in this file when they are introduced.

Current known adaptation:

- `SettlePnl` wrapper flow uses the v16.8.5 released-PnL conversion path to move released PnL into withdrawable capital.
```

- [ ] **Step 7: Add NOTICE entry**

Append to `NOTICE`:

```txt
OpenPerps vendors and adapts the Percolator v16 risk engine.
Upstream source: aeyakovenko/percolator
Pinned engine baseline: v16.8.5, commit 7188eece
Wrapper adaptations are documented in docs/engine-upstream.md.
```

- [ ] **Step 8: Final grep checks**

Run:

```powershell
rg "settle_realized_pnl_not_atomic" crates/program/src
rg "convert_released_pnl_to_capital" crates/program/src
```

Expected: first command finds nothing in wrapper settle flow; second command finds the updated SettlePnl path.

- [ ] **Step 9: Commit**

```powershell
git add crates/engine crates/program ts/sdk/src/instructions.ts NOTICE docs/engine-upstream.md
git commit -m "chore: re-vendor percolator v16 engine baseline"
```

## Task 1: Add SDK Market Config Types

**Files:**
- Create: `ts/sdk/src/config.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/config.test.ts`
- Modify: `ts/sdk/package.json`

Important config semantics:

- `status` is advisory off-chain metadata for registries, UIs, bots, and keepers. It does not by itself pause or close-only a market on-chain.
- `maxLeverage` is SDK/UI risk metadata. The engine enforces margin and risk constraints, but it does not have a native config field named `maxLeverage`.
- `priceDecimals`, `sizeDecimals`, and `quoteDecimals` are display/conversion metadata. Engine fixed-point scales are internal; SDK helpers must map user-facing units into engine atoms.

- [ ] **Step 1: Add test runner dependency and script**

Modify `ts/sdk/package.json` so scripts include:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test --import tsx \"test/**/*.test.ts\"",
    "smoke": "tsx scripts/smoke.ts"
  }
}
```

Add dev dependency if missing:

```json
{
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Write failing config tests**

Create `ts/sdk/test/config.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  createJsonMarketRegistry,
  validateMarketConfig,
  type OpenPerpsMarketConfig,
} from "../src/config.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "sol-devnet",
  cluster: "devnet",
  programId: "11111111111111111111111111111111",
  market: "11111111111111111111111111111111",
  assetIndex: 0,
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "11111111111111111111111111111111",
  symbol: "SOL-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "major",
  maxLeverage: 10,
  status: "active",
};

test("validateMarketConfig accepts a valid v1 market config", () => {
  assert.deepEqual(validateMarketConfig(market), market);
});

test("validateMarketConfig rejects unsupported schema versions", () => {
  assert.throws(
    () => validateMarketConfig({ ...market, schemaVersion: 2 } as unknown),
    /unsupported market config schemaVersion/i,
  );
});

test("json registry lists and fetches markets by id", async () => {
  const registry = createJsonMarketRegistry([market]);
  assert.deepEqual(await registry.listMarkets(), [market]);
  assert.deepEqual(await registry.getMarket("sol-devnet"), market);
  assert.equal(await registry.getMarket("missing"), null);
});
```

- [ ] **Step 3: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist or exports are missing.

- [ ] **Step 4: Implement config module**

Create `ts/sdk/src/config.ts`:

```ts
export type OpenPerpsCluster = "devnet" | "mainnet-beta";
export type OpenPerpsRiskTier = "major" | "standard" | "experimental";
export type OpenPerpsMarketStatus = "draft" | "active" | "paused" | "close-only" | "settled";

export type OpenPerpsMarketConfig = {
  schemaVersion: 1;
  id: string;
  cluster: OpenPerpsCluster;
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
  riskTier: OpenPerpsRiskTier;
  maxLeverage: number;
  status: OpenPerpsMarketStatus;
  keeper?: {
    oracleAuthority?: string;
    expectedCrankIntervalMs?: number;
  };
  metadata?: {
    logoURI?: string;
    website?: string;
    tags?: string[];
  };
};

export type MarketRegistryProvider = {
  listMarkets(): Promise<OpenPerpsMarketConfig[]>;
  getMarket(id: string): Promise<OpenPerpsMarketConfig | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid market config ${field}`);
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid market config ${field}`);
  }
  return value;
}

export function validateMarketConfig(value: unknown): OpenPerpsMarketConfig {
  if (!isRecord(value)) throw new Error("invalid market config");
  if (value.schemaVersion !== 1) {
    throw new Error(`unsupported market config schemaVersion: ${String(value.schemaVersion)}`);
  }

  const cluster = expectString(value.cluster, "cluster");
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new Error(`invalid market config cluster: ${cluster}`);
  }

  const riskTier = expectString(value.riskTier, "riskTier");
  if (riskTier !== "major" && riskTier !== "standard" && riskTier !== "experimental") {
    throw new Error(`invalid market config riskTier: ${riskTier}`);
  }

  const status = expectString(value.status, "status");
  if (!["draft", "active", "paused", "close-only", "settled"].includes(status)) {
    throw new Error(`invalid market config status: ${status}`);
  }

  return {
    schemaVersion: 1,
    id: expectString(value.id, "id"),
    cluster,
    programId: expectString(value.programId, "programId"),
    market: expectString(value.market, "market"),
    assetIndex: expectNumber(value.assetIndex, "assetIndex"),
    baseMint: expectString(value.baseMint, "baseMint"),
    quoteMint: expectString(value.quoteMint, "quoteMint"),
    symbol: expectString(value.symbol, "symbol"),
    name: typeof value.name === "string" ? value.name : undefined,
    priceDecimals: expectNumber(value.priceDecimals, "priceDecimals"),
    sizeDecimals: expectNumber(value.sizeDecimals, "sizeDecimals"),
    quoteDecimals: expectNumber(value.quoteDecimals, "quoteDecimals"),
    poolAddress: typeof value.poolAddress === "string" ? value.poolAddress : undefined,
    dex: typeof value.dex === "string" ? value.dex : undefined,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : undefined,
    riskTier,
    maxLeverage: expectNumber(value.maxLeverage, "maxLeverage"),
    status,
    keeper: isRecord(value.keeper) ? {
      oracleAuthority: typeof value.keeper.oracleAuthority === "string" ? value.keeper.oracleAuthority : undefined,
      expectedCrankIntervalMs: typeof value.keeper.expectedCrankIntervalMs === "number" ? value.keeper.expectedCrankIntervalMs : undefined,
    } : undefined,
    metadata: isRecord(value.metadata) ? {
      logoURI: typeof value.metadata.logoURI === "string" ? value.metadata.logoURI : undefined,
      website: typeof value.metadata.website === "string" ? value.metadata.website : undefined,
      tags: Array.isArray(value.metadata.tags) ? value.metadata.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    } : undefined,
  };
}

export function createJsonMarketRegistry(markets: OpenPerpsMarketConfig[]): MarketRegistryProvider {
  const validated = markets.map(validateMarketConfig);
  return {
    async listMarkets() {
      return validated;
    },
    async getMarket(id: string) {
      return validated.find((market) => market.id === id) ?? null;
    },
  };
}
```

- [ ] **Step 5: Export config module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add ts/sdk/package.json ts/sdk/package-lock.json ts/sdk/src/config.ts ts/sdk/src/index.ts ts/sdk/test/config.test.ts
git commit -m "feat(sdk): add market config registry"
```

## Task 2: Add SDK Intent Types And Validation

**Files:**
- Create: `ts/sdk/src/intents.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/intents.test.ts`

Important intent semantics:

- `OpenPerpsTradeIntent` is an SDK format, not an on-chain order type.
- `size` is desired position size in base units after applying `sizeDecimals`; it is not margin. Margin comes from capital already deposited in the user's portfolio.
- `placeTrade` must resolve the House/LP counterparty before building the transaction.
- Official markets use the configured shared House/LP portfolio.
- Custom markets use the creator/integrator House/LP portfolio from config.
- Execution price must come from keeper-certified/on-chain mark state, not from client chart data.
- `limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK-side guards in v1, not native on-chain orderbook semantics.
- `maxLeverage` is enforced by SDK/UI preflight and integrator policy, not by a native engine field with that name.
- `clientOrderId` is client-side correlation metadata only; it is not enforced as a unique on-chain order id.

Minimum quote state:

```ts
type QuoteMarketState = {
  markPrice: string;
  feeBps?: number;
  openInterestLong?: string;
  openInterestShort?: string;
  fundingRateE9?: string;
  slotLast?: number;
  currentSlot?: number;
};
```

`quoteTradeIntent` should use `markPrice` as the execution reference, estimate fees when `feeBps` is present, and surface staleness if `slotLast` is too far behind `currentSlot`.

- [ ] **Step 1: Write failing intent tests**

Create `ts/sdk/test/intents.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  validateMarketCreationIntent,
  validateTradeIntent,
  type OpenPerpsMarketCreationIntent,
  type OpenPerpsTradeIntent,
} from "../src/intents.ts";

test("validateTradeIntent accepts long and short intents", () => {
  const intent: OpenPerpsTradeIntent = {
    schemaVersion: 1,
    marketId: "sol-devnet",
    side: "long",
    size: "1000000",
    maxSlippageBps: 50,
  };
  assert.deepEqual(validateTradeIntent(intent), intent);
  assert.equal(validateTradeIntent({ ...intent, side: "short" }).side, "short");
});

test("validateTradeIntent rejects invalid side", () => {
  assert.throws(
    () => validateTradeIntent({ schemaVersion: 1, marketId: "x", side: "buy", size: "1" }),
    /invalid trade intent side/i,
  );
});

test("validateMarketCreationIntent accepts external price provider", () => {
  const intent: OpenPerpsMarketCreationIntent = {
    schemaVersion: 1,
    baseMint: "Base111111111111111111111111111111111111111",
    quoteMint: "Quote11111111111111111111111111111111111111",
    symbol: "TEST-PERP",
    initialPrice: "1000000",
    maxLeverage: 5,
    riskTier: "experimental",
    priceProvider: {
      type: "external",
      id: "integrator-feed",
    },
  };
  assert.deepEqual(validateMarketCreationIntent(intent), intent);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- intents.test.ts
```

Expected: FAIL because `src/intents.ts` does not exist.

- [ ] **Step 3: Implement intents module**

Create `ts/sdk/src/intents.ts`:

```ts
import type { OpenPerpsRiskTier } from "./config.ts";

export type OpenPerpsTradeSide = "long" | "short";

export type OpenPerpsTradeIntent = {
  schemaVersion: 1;
  marketId: string;
  side: OpenPerpsTradeSide;
  size: string;
  limitPrice?: string;
  maxSlippageBps?: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
};

export type OpenPerpsMarketCreationIntent = {
  schemaVersion: 1;
  baseMint: string;
  quoteMint: string;
  symbol: string;
  name?: string;
  initialPrice: string;
  maxLeverage: number;
  riskTier: OpenPerpsRiskTier;
  priceProvider: {
    type: "external";
    id: string;
    description?: string;
  };
  lpVault?: {
    initialDeposit?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expectSchemaVersion(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) {
    throw new Error(`unsupported ${label} schemaVersion: ${String(value.schemaVersion)}`);
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${field}`);
  return value;
}

export function validateTradeIntent(value: unknown): OpenPerpsTradeIntent {
  if (!isRecord(value)) throw new Error("invalid trade intent");
  expectSchemaVersion(value, "trade intent");

  const side = expectString(value.side, "trade intent side");
  if (side !== "long" && side !== "short") throw new Error(`invalid trade intent side: ${side}`);

  return {
    schemaVersion: 1,
    marketId: expectString(value.marketId, "trade intent marketId"),
    side,
    size: expectString(value.size, "trade intent size"),
    limitPrice: typeof value.limitPrice === "string" ? value.limitPrice : undefined,
    maxSlippageBps: typeof value.maxSlippageBps === "number" ? value.maxSlippageBps : undefined,
    reduceOnly: typeof value.reduceOnly === "boolean" ? value.reduceOnly : undefined,
    clientOrderId: typeof value.clientOrderId === "string" ? value.clientOrderId : undefined,
  };
}

export function validateMarketCreationIntent(value: unknown): OpenPerpsMarketCreationIntent {
  if (!isRecord(value)) throw new Error("invalid market creation intent");
  expectSchemaVersion(value, "market creation intent");

  const riskTier = expectString(value.riskTier, "market creation intent riskTier");
  if (riskTier !== "major" && riskTier !== "standard" && riskTier !== "experimental") {
    throw new Error(`invalid market creation intent riskTier: ${riskTier}`);
  }

  if (!isRecord(value.priceProvider)) {
    throw new Error("invalid market creation intent priceProvider");
  }

  const providerType = expectString(value.priceProvider.type, "market creation intent priceProvider.type");
  if (providerType !== "external") {
    throw new Error(`invalid market creation intent priceProvider.type: ${providerType}`);
  }

  return {
    schemaVersion: 1,
    baseMint: expectString(value.baseMint, "market creation intent baseMint"),
    quoteMint: expectString(value.quoteMint, "market creation intent quoteMint"),
    symbol: expectString(value.symbol, "market creation intent symbol"),
    name: typeof value.name === "string" ? value.name : undefined,
    initialPrice: expectString(value.initialPrice, "market creation intent initialPrice"),
    maxLeverage: expectNumber(value.maxLeverage, "market creation intent maxLeverage"),
    riskTier,
    priceProvider: {
      type: "external",
      id: expectString(value.priceProvider.id, "market creation intent priceProvider.id"),
      description: typeof value.priceProvider.description === "string" ? value.priceProvider.description : undefined,
    },
    lpVault: isRecord(value.lpVault) ? {
      initialDeposit: typeof value.lpVault.initialDeposit === "string" ? value.lpVault.initialDeposit : undefined,
    } : undefined,
  };
}
```

- [ ] **Step 4: Export intents module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
export * from "./intents.ts";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/intents.ts ts/sdk/src/index.ts ts/sdk/test/intents.test.ts
git commit -m "feat(sdk): add integration intent types"
```

## Task 3: Add Price Provider Interface

**Files:**
- Create: `ts/sdk/src/price.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/price.test.ts`

- [ ] **Step 1: Write failing price provider tests**

Create `ts/sdk/test/price.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createStaticPriceProvider } from "../src/price.ts";
import type { OpenPerpsMarketConfig } from "../src/config.ts";

const market: OpenPerpsMarketConfig = {
  schemaVersion: 1,
  id: "test",
  cluster: "devnet",
  programId: "11111111111111111111111111111111",
  market: "11111111111111111111111111111111",
  assetIndex: 0,
  baseMint: "base",
  quoteMint: "quote",
  symbol: "TEST-PERP",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  riskTier: "experimental",
  maxLeverage: 5,
  status: "active",
};

test("static price provider returns configured price", async () => {
  const provider = createStaticPriceProvider(123n, "unit-test");
  const result = await provider.getPrice(market);
  assert.equal(result.price, 123n);
  assert.equal(result.source, "unit-test");
  assert.equal(typeof result.timestampMs, "number");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- price.test.ts
```

Expected: FAIL because `src/price.ts` does not exist.

- [ ] **Step 3: Implement price module**

Create `ts/sdk/src/price.ts`:

```ts
import type { OpenPerpsMarketConfig } from "./config.ts";

export type OpenPerpsPrice = {
  price: bigint;
  confidence?: bigint;
  slot?: number;
  source: string;
  timestampMs: number;
};

export type PriceProvider = {
  getPrice(market: OpenPerpsMarketConfig): Promise<OpenPerpsPrice>;
};

export function createStaticPriceProvider(price: bigint, source = "static"): PriceProvider {
  return {
    async getPrice() {
      return {
        price,
        source,
        timestampMs: Date.now(),
      };
    },
  };
}
```

- [ ] **Step 4: Export price module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
export * from "./intents.ts";
export * from "./price.ts";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/price.ts ts/sdk/src/index.ts ts/sdk/test/price.test.ts
git commit -m "feat(sdk): define price provider interface"
```

## Task 4: Add Friendly Decoder Module

**Files:**
- Create: `ts/sdk/src/decoders.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/decoders.test.ts`

- [ ] **Step 1: Write failing decoder tests**

Create `ts/sdk/test/decoders.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioSummary,
  portfolioAccountSize,
} from "../src/decoders.ts";

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

test("decodePortfolioSummary reads capital and pnl", () => {
  const data = new Uint8Array(portfolioAccountSize(1));
  writeU128LE(data, OFFSET_CAPITAL, 50_000_000n);
  writeU128LE(data, OFFSET_PNL, 1_000_000n);
  const summary = decodePortfolioSummary(data);
  assert.equal(summary.capital, 50_000_000n);
  assert.equal(summary.pnl, 1_000_000n);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- decoders.test.ts
```

Expected: FAIL because `src/decoders.ts` does not exist.

- [ ] **Step 3: Implement decoders module**

Create `ts/sdk/src/decoders.ts`:

```ts
export {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioPositions,
  portfolioAccountSize,
  readI128LE,
  readU128LE,
  readU64LE,
} from "./layout.ts";

import {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioPositions,
  readI128LE,
  readU128LE,
} from "./layout.ts";

export type DecodedPortfolioSummary = {
  capital: bigint;
  pnl: bigint;
  positions: ReturnType<typeof decodePortfolioPositions>;
};

export function decodePortfolioSummary(data: Uint8Array): DecodedPortfolioSummary {
  return {
    capital: readU128LE(data, OFFSET_CAPITAL),
    pnl: readI128LE(data, OFFSET_PNL),
    positions: decodePortfolioPositions(data),
  };
}
```

- [ ] **Step 4: Export decoders module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
export * from "./intents.ts";
export * from "./price.ts";
export * from "./decoders.ts";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/decoders.ts ts/sdk/src/index.ts ts/sdk/test/decoders.test.ts
git commit -m "feat(sdk): add friendly decoders"
```

## Task 5: Add Build-only Transaction Helpers

**Files:**
- Create: `ts/sdk/src/transactions.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/transactions.test.ts`

- [ ] **Step 1: Inspect existing instruction signatures**

Run:

```powershell
cd ts/sdk
Select-String -Path src/instructions.ts -Pattern "export function .*Ix|export function .*Instruction|export function build" -Context 0,2
```

Expected: list of existing builder names. Use those exact names when wiring helpers.

- [ ] **Step 2: Write failing transaction tests**

Create `ts/sdk/test/transactions.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, Transaction } from "@solana/web3.js";

import { transactionFromInstructions } from "../src/transactions.ts";

test("transactionFromInstructions wraps instructions in a Transaction", () => {
  const tx = transactionFromInstructions([]);
  assert.ok(tx instanceof Transaction);
  assert.equal(tx.instructions.length, 0);
});

test("transactionFromInstructions assigns fee payer when provided", () => {
  const payer = PublicKey.default;
  const tx = transactionFromInstructions([], { feePayer: payer });
  assert.equal(tx.feePayer?.toBase58(), payer.toBase58());
});
```

- [ ] **Step 3: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- transactions.test.ts
```

Expected: FAIL because `src/transactions.ts` does not exist.

- [ ] **Step 4: Implement transaction helpers**

Create `ts/sdk/src/transactions.ts`:

```ts
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

export type TransactionBuildOptions = {
  feePayer?: PublicKey;
  recentBlockhash?: BlockhashWithExpiryBlockHeight;
};

export function transactionFromInstructions(
  instructions: TransactionInstruction[],
  options: TransactionBuildOptions = {},
): Transaction {
  const tx = new Transaction();
  if (options.feePayer) tx.feePayer = options.feePayer;
  if (options.recentBlockhash) {
    tx.recentBlockhash = options.recentBlockhash.blockhash;
    tx.lastValidBlockHeight = options.recentBlockhash.lastValidBlockHeight;
  }
  for (const ix of instructions) tx.add(ix);
  return tx;
}
```

- [ ] **Step 5: Export transactions module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
export * from "./intents.ts";
export * from "./price.ts";
export * from "./decoders.ts";
export * from "./transactions.ts";
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add ts/sdk/src/transactions.ts ts/sdk/src/index.ts ts/sdk/test/transactions.test.ts
git commit -m "feat(sdk): add build-only transaction helpers"
```

## Task 6: Add Send-ready Action Skeleton

**Files:**
- Create: `ts/sdk/src/actions.ts`
- Modify: `ts/sdk/src/index.ts`
- Test: `ts/sdk/test/actions.test.ts`

- [ ] **Step 1: Write failing action tests**

Create `ts/sdk/test/actions.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, Transaction } from "@solana/web3.js";

import { createOpenPerpsActions } from "../src/actions.ts";

test("createOpenPerpsActions exposes connection-bound helpers", () => {
  const actions = createOpenPerpsActions({
    connection: {
      sendTransaction: async () => "sig",
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  });
  assert.equal(typeof actions.sendTransaction, "function");
});

test("sendTransaction signs and sends a transaction", async () => {
  let sent = false;
  const actions = createOpenPerpsActions({
    connection: {
      sendTransaction: async () => {
        sent = true;
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  });
  const sig = await actions.sendTransaction(new Transaction(), [Keypair.generate()]);
  assert.equal(sig, "sig");
  assert.equal(sent, true);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd ts/sdk
npm test -- actions.test.ts
```

Expected: FAIL because `src/actions.ts` does not exist.

- [ ] **Step 3: Implement action skeleton**

Create `ts/sdk/src/actions.ts`:

```ts
import type {
  Keypair,
  SendOptions,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";

type MinimalConnection = {
  sendTransaction(tx: Transaction, signers: Keypair[], opts?: SendOptions): Promise<string>;
  confirmTransaction(sig: string, commitment?: string): Promise<{ value: { err: unknown } }>;
};

export type OpenPerpsActionsConfig = {
  connection: MinimalConnection;
  sendOptions?: SendOptions;
};

export type OpenPerpsActions = {
  sendTransaction(tx: Transaction, signers: Keypair[]): Promise<TransactionSignature>;
};

export function createOpenPerpsActions(config: OpenPerpsActionsConfig): OpenPerpsActions {
  return {
    async sendTransaction(tx, signers) {
      const signature = await config.connection.sendTransaction(tx, signers, config.sendOptions);
      await config.connection.confirmTransaction(signature, "confirmed");
      return signature;
    },
  };
}
```

- [ ] **Step 4: Export actions module**

Modify `ts/sdk/src/index.ts`:

```ts
export * from "./layout.ts";
export * from "./instructions.ts";
export * from "./config.ts";
export * from "./intents.ts";
export * from "./price.ts";
export * from "./decoders.ts";
export * from "./transactions.ts";
export * from "./actions.ts";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/actions.ts ts/sdk/src/index.ts ts/sdk/test/actions.test.ts
git commit -m "feat(sdk): add send-ready action wrapper"
```

## Task 7: Add Trade Resolution And Lifecycle Design

**Files:**
- Create: `ts/sdk/src/trade-resolution.ts`
- Create: `ts/sdk/test/trade-resolution.test.ts`
- Create: `docs/lifecycle.md`

- [ ] **Step 1: Add failing tests for trade guards**

Create `ts/sdk/test/trade-resolution.test.ts` with tests for:

```ts
// Required behaviors:
// 1. official market requires a configured House/LP counterparty
// 2. custom market requires a creator/integrator House/LP counterparty
// 3. limitPrice rejects execution price outside user guard
// 4. maxSlippageBps rejects execution price outside tolerance
// 5. reduceOnly rejects when the intent would increase exposure
```

Expected first run: FAIL because `trade-resolution.ts` does not exist.

- [ ] **Step 2: Implement SDK-side resolution model**

Create `ts/sdk/src/trade-resolution.ts` with pure functions only.

The module must document:

- official markets trade against configured shared House/LP portfolio
- custom markets trade against creator/integrator House/LP portfolio
- execution price comes from keeper-certified/on-chain mark state
- client/chart price is display and prefill only
- `limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK guards
- `maxLeverage` is SDK/UI risk policy metadata, not a native engine field

- [ ] **Step 3: Add lifecycle docs**

Create `docs/lifecycle.md`:

```md
# Position Lifecycle

The high-level user path is:

1. open position against House/LP
2. oracle/keeper moves mark price
3. close position
4. settle realized PnL into withdrawable capital
5. withdraw available capital

Profitable realized PnL must be settled into capital before it is withdrawable.
```

- [ ] **Step 4: Add lifecycle test requirement**

Add to `docs/lifecycle.md`:

```md
Before claiming the high-level close/withdraw flow complete, add an integration test that opens versus House, moves price into profit, closes, settles PnL, withdraws, and asserts portfolio/vault balances.
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/trade-resolution.ts ts/sdk/test/trade-resolution.test.ts docs/lifecycle.md
git commit -m "feat(sdk): define trade intent resolution guards"
```

## Task 8: Add Market Creation Resolution Design

**Files:**
- Create: `ts/sdk/src/market-creation.ts`
- Create: `ts/sdk/test/market-creation.test.ts`
- Modify: `docs/market-creation-intent.md`

- [ ] **Step 1: Add failing tests for market creation mapping**

Create `ts/sdk/test/market-creation.test.ts` with tests for:

```ts
// Required behaviors:
// 1. createMarket plan includes InitMarket
// 2. createMarket plan includes CreateVault
// 3. createMarket plan includes CreateHouseVault
// 4. createMarket plan includes FundHouseVault when lpVault.initialDeposit is present
// 5. createMarket plan includes ActivateMarket
// 6. devnet/demo plan can include CreateMockPool when requested
// 7. priceProvider.id is preserved as keeper/oracle binding metadata
```

Expected first run: FAIL because `market-creation.ts` does not exist.

- [ ] **Step 2: Implement SDK-side market creation planner**

Create `ts/sdk/src/market-creation.ts` with pure planning functions first:

```ts
// This module should not send transactions in v1.
// It turns OpenPerpsMarketCreationIntent into an ordered creation plan.
```

The plan must document this order:

```txt
InitMarket
CreateVault
CreateHouseVault
FundHouseVault
ActivateMarket
optional devnet CreateMockPool
oracle binding
```

- [ ] **Step 3: Document House/LP and oracle binding**

Update `docs/market-creation-intent.md`:

```md
`OpenPerpsMarketCreationIntent` is an SDK format, not one on-chain instruction.

`createMarket(intent)` composes InitMarket, CreateVault, CreateHouseVault, FundHouseVault, ActivateMarket, optional devnet CreateMockPool, and oracle binding.

`lpVault.initialDeposit` funds the House/LP counterparty used for matched-cross trading.

`priceProvider.id` is a keeper/integration identifier. It is not a trusted price by itself.
```

- [ ] **Step 4: Add lifecycle test requirement**

Add to `docs/market-creation-intent.md`:

```md
Before claiming custom market creation complete, add an integration test that creates a market from intent, creates/funds House/LP, activates it, runs one keeper/oracle update, opens a trade against House/LP, and asserts state is usable.
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ts/sdk/src/market-creation.ts ts/sdk/test/market-creation.test.ts docs/market-creation-intent.md
git commit -m "feat(sdk): define market creation lifecycle"
```

## Task 9: Add Permission Map And Result Types

**Files:**
- Create: `docs/permissions.md`
- Modify: `docs/sdk.md`
- Modify: `docs/keeper.md`

- [ ] **Step 1: Create permission map docs**

Create `docs/permissions.md`:

```md
# Permission Map

| Instruction | Permission model |
| --- | --- |
| `InitMarket` | Open or configured by market creation flow, depending on deployment policy |
| `InitPortfolio` | Open |
| `Deposit` | Portfolio owner signer |
| `Withdraw` | Portfolio owner signer |
| `Trade` / `PlaceOrder` | Required portfolio owner/delegate signers |
| `Liquidate` | Permissionless; program rejects healthy accounts |
| `CrankRefresh` | Permissionless refresh/protective path |
| `ActivateMarket` | Authority-pinned |
| `AccrueAsset` | Authority-pinned oracle/funding update |
| `ResolveMarket` | Authority-pinned |
| `CreateVault` | Market authority / creation flow |
| `CreateHouseVault` | Market authority / creation flow |
| `FundHouseVault` | Authority-only or configured House/LP funder |
| `WithdrawHouseVault` | Authority-only |
| `SetDelegate` | Portfolio owner signer |
| `SettlePnl` | Portfolio owner/delegate path, according to program guard |
```

- [ ] **Step 2: Document keeper authority binding**

Add to `docs/keeper.md`:

```md
For `AccrueAsset`, the keeper signer must match the market's pinned oracle authority. If the signer does not match `keeper.oracleAuthority` / on-chain authority, the program rejects the oracle/funding update.
```

- [ ] **Step 3: Document result types**

Add to `docs/sdk.md`:

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

- [ ] **Step 4: Commit**

```powershell
git add docs/permissions.md docs/sdk.md docs/keeper.md
git commit -m "docs: add permission map and sdk result types"
```

## Task 10: Write SDK And Safety Docs

**Files:**
- Modify: `README.md`
- Create: `docs/quickstart.md`
- Create: `docs/sdk.md`
- Create: `docs/market-config.md`
- Create: `docs/trade-intent.md`
- Create: `docs/market-creation-intent.md`
- Create: `docs/permissions.md`
- Create: `docs/oracle-and-price-safety.md`
- Create: `docs/security-and-limitations.md`

- [ ] **Step 1: Update README opening**

Modify the first section of `README.md` to lead with:

```md
# OpenPerps

OpenPerps is an open-source perp layer for Solana apps.

It lets Solana applications add permissionless perpetual markets, trading, positions, PnL, and keeper automation through SDKs and embeddable components.

The SDK is the primary integration surface. React components provide a fast integration path for teams that want ready-made trade, chart, and position UI. Teams can also use the SDK directly to build their own interface, bot, or backend flow.
```

Add a warning block near the top:

```md
> Devnet by default. Mainnet-capable, not production-approved.
>
> OpenPerps v1 is unaudited. Do not use with real user funds unless you complete your own review and accept the risk.
```

Add a mainnet qualifier:

```md
Mainnet-capable means SDK/config/program flows can target `mainnet-beta`. The current authority-pushed oracle path is not production-approved and is the main blocker for serious mainnet use.
```

- [ ] **Step 2: Create `docs/sdk.md`**

Write:

```md
# SDK

`@openperps/sdk` is the primary integration surface for OpenPerps.

It exposes two layers:

- low-level builders for instructions, PDAs, and decoders
- high-level helpers for common flows

Every send-ready helper should have a build-only equivalent so browser apps can let wallets sign transactions themselves.

## Import

```ts
import {
  createJsonMarketRegistry,
  validateTradeIntent,
  transactionFromInstructions,
} from "@openperps/sdk";
```

## Integration Paths

Use the SDK directly when building:

- DEX terminals
- Telegram bots
- backend scripts
- wallets
- custom launchpad flows
```

- [ ] **Step 2b: Create `docs/quickstart.md`**

Create `docs/quickstart.md`:

```md
# Quickstart

OpenPerps examples are devnet-default.

The fastest integration path is:

1. load or create an `OpenPerpsMarketConfig`
2. create a `MarketRegistryProvider`
3. build a trade intent
4. use SDK build-only helpers for wallet apps or send-ready actions for Node scripts
5. run a keeper against the same market config

Mainnet-capable means SDK/config/program flows can target `mainnet-beta`. The current authority-pushed oracle path is not production-approved and is the main blocker for serious mainnet use.
```

- [ ] **Step 3: Create market and intent docs**

Create `docs/market-config.md`, `docs/trade-intent.md`, and `docs/market-creation-intent.md` using the exact type definitions from the spec.

`docs/market-config.md` must state:

```md
`status` is advisory off-chain metadata. It does not by itself pause or close-only a market on-chain.

`priceDecimals`, `sizeDecimals`, and `quoteDecimals` are display/conversion metadata. The engine uses fixed internal scales; SDK helpers convert user-facing units into engine atoms.
```

`docs/trade-intent.md` must state:

```md
`OpenPerpsTradeIntent` is an SDK format, not an on-chain order type.

`size` is position size in base units after applying `sizeDecimals`; it is not margin.

Execution price must resolve from keeper-certified/on-chain mark state, not from client chart data.

`limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK-side guards in v1.

`clientOrderId` is client-side correlation metadata and is not enforced on-chain.
```

- [ ] **Step 4: Create oracle safety docs**

Create `docs/oracle-and-price-safety.md`:

```md
# Oracle And Price Safety

OpenPerps does not need to be the market data provider in v1.

Integrators provide their own price source and chart data.

Client-rendered prices, chart prices, DOM-scraped prices, and third-party frontend prices can be used for display and prefill only. Settlement, PnL, funding, and liquidation must use the keeper/oracle path.

The keeper consumes a `PriceProvider` interface and pushes authenticated prices on-chain.

The current manual authority oracle path is acceptable for devnet/demo flows but is not production-approved for serious mainnet use.
```

- [ ] **Step 5: Create security limitations docs**

Create `docs/security-and-limitations.md`:

```md
# Security And Limitations

OpenPerps v1 is devnet-default and mainnet-capable, but not production-approved.

Unaudited means OpenPerps has not yet received an independent third-party security and risk review.

An audit should cover:

- Solana account validation
- signer and authority checks
- PDA derivation and ownership assumptions
- SPL token custody and CPI flows
- deposit and withdraw safety
- delegate/session key permissions
- trade, PnL, funding, and settlement logic
- liquidation correctness
- oracle authority, stale price, and manipulation assumptions
- keeper reliability assumptions
- LP and insurance vault risk
- custom SPL market risk

Do not use with real user funds unless you complete your own review and accept the risk.

The current authority-pushed oracle trust model is the first mainnet blocker to remove.
```

- [ ] **Step 6: Run docs grep checks**

Run:

```powershell
rg "OPP|staking|revenue share|buyback" README.md docs
rg "standalone exchange frontend|not a standalone" README.md docs
```

Expected: no `$OPP`/token-economics mentions in OSS v1 docs, and no defensive "not standalone" phrasing.

- [ ] **Step 7: Commit**

```powershell
git add README.md docs/quickstart.md docs/sdk.md docs/market-config.md docs/trade-intent.md docs/market-creation-intent.md docs/permissions.md docs/oracle-and-price-safety.md docs/security-and-limitations.md
git commit -m "docs: reposition openperps as sdk-first oss layer"
```

## Task 11: Add Keeper Core-only Design Docs

**Files:**
- Create: `docs/keeper.md`
- Create: `docs/keeper-config.example.ts`
- Create: `docs/keeper-freshness.md`

- [ ] **Step 1: Create keeper docs**

Create `docs/keeper.md`:

```md
# Keeper

`@openperps/keeper` is the self-hosted process responsible for core market safety operations.

V1 responsibilities:

- load multiple market configs
- call price providers
- push oracle/funding updates
- scan for liquidations
- submit liquidation transactions
- log health and errors

V1 does not include:

- analytics dashboard
- candles
- billing
- hosted tenant registry
- full trade feed API
- SLA system

The initial runner is a simple multi-market loop. OI-gated scheduling can come later.

For `AccrueAsset`, the keeper signer must match the market's pinned oracle authority. If the signer does not match, the program rejects the oracle/funding update.

The keeper must push oracle updates frequently enough to respect the engine's per-slot price-move bound and `max_accrual_dt_slots` freshness window. A large jump or long gap will be rejected. When a slot has fallen behind, the keeper or trade path must burst catch-up accruals to clear staleness before risk-increasing trades succeed.
```

- [ ] **Step 2: Create keeper freshness docs**

Create `docs/keeper-freshness.md`:

```md
# Keeper Freshness

The keeper is part of the risk system, not just a price cron.

For assets with open interest, the engine enforces:

- per-slot price-move bound
- `max_accrual_dt_slots` freshness window

Each `AccrueAsset` can only move price within the configured `max_price_move_bps_per_slot * dt` budget. If the keeper pushes a large jump or waits too long, the program can reject the update, including `RecoveryRequired`.

If `slot_last` falls too far behind current slot, risk-increasing trades can be blocked with `LockActive`.

When a market falls behind, the keeper or trade path must run burst catch-up accruals to clear staleness before risk-increasing trades succeed.
```

- [ ] **Step 3: Create keeper config example**

Create `docs/keeper-config.example.ts`:

```ts
import type { OpenPerpsMarketConfig, PriceProvider } from "@openperps/sdk";

export const markets: OpenPerpsMarketConfig[] = [
  {
    schemaVersion: 1,
    id: "sol-devnet",
    cluster: "devnet",
    programId: "PROGRAM_ID",
    market: "MARKET_ACCOUNT",
    assetIndex: 0,
    baseMint: "BASE_MINT",
    quoteMint: "QUOTE_MINT",
    symbol: "SOL-PERP",
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier: "major",
    maxLeverage: 10,
    status: "active",
  },
];

export const priceProvider: PriceProvider = {
  async getPrice(market) {
    return {
      price: 100_000_000n,
      source: `example:${market.id}`,
      timestampMs: Date.now(),
    };
  },
};
```

Important market creation semantics:

- `OpenPerpsMarketCreationIntent` is an SDK format, not one on-chain instruction.
- `createMarket(intent)` composes a lifecycle: `InitMarket` -> `CreateVault` -> `CreateHouseVault` -> `FundHouseVault` -> `ActivateMarket` -> optional devnet `CreateMockPool` -> oracle binding.
- `lpVault.initialDeposit` must flow into the House/LP vault used as counterparty.
- `priceProvider.id` is a keeper/integration identifier, not a trusted price by itself.
- The keeper signer must still match the market's pinned oracle authority for price/funding updates.

- [ ] **Step 4: Commit**

```powershell
git add docs/keeper.md docs/keeper-freshness.md docs/keeper-config.example.ts
git commit -m "docs: define core keeper scope"
```

## Task 12: Add Example Skeletons

**Files:**
- Create: `examples/node-create-market/README.md`
- Create: `examples/launchpad/README.md`
- Create: `examples/dex-terminal/README.md`
- Create: `examples/token-page/README.md`
- Create: `examples/wallet-position-card/README.md`
- Create: `examples/telegram-bot/README.md`
- Create: `docs/examples.md`

- [ ] **Step 1: Create example README files**

Each example README must include:

```md
# Example Name

This example shows how to integrate OpenPerps through `@openperps/sdk`.

## What It Demonstrates

- ...

## Boundaries

This example is devnet-default. It is not production-approved.
```

Use these bullets:

- `node-create-market`: market creation intent, local registry, keeper config
- `launchpad`: token page market creation, trade widget, integrator-provided chart data
- `dex-terminal`: registry list, market filter, chart shell, trade intent
- `token-page`: single market config, trade widget, position widget
- `wallet-position-card`: wallet-owned position and PnL display
- `telegram-bot`: `/market`, `/long`, `/short`, `/position`, trade intent formatting

- [ ] **Step 2: Create `docs/examples.md`**

Create:

```md
# Examples

OpenPerps examples are organized by integration surface.

## SDK-only

Use `examples/node-create-market` when building backend scripts or market creation tools.

## Launchpad

Use `examples/launchpad` when adding perps to a token launch page.

## DEX Terminal

Use `examples/dex-terminal` when adding perps to a trading terminal or market browser.

## Token Page

Use `examples/token-page` when one page maps to one token market.

## Wallet / Portfolio

Use `examples/wallet-position-card` when showing OpenPerps positions inside a wallet or portfolio app.

## Telegram Bot

Use `examples/telegram-bot` when building command-driven trading flows.
```

- [ ] **Step 3: Commit**

```powershell
git add examples docs/examples.md
git commit -m "docs: add integration example map"
```

## Task 13: Add React Component Contract Docs

**Files:**
- Create: `docs/react-components.md`

- [ ] **Step 1: Create React component docs**

Create `docs/react-components.md`:

```md
# React Components

React components provide a fast integration path for teams that want ready-made trade, chart, and position UI.

The SDK remains the primary integration surface. Teams can use the SDK directly to build their own interface, bot, mobile app, or backend flow.

## Planned Components

```tsx
<OpenPerpsTrade market={market} />
<OpenPerpsChart market={market} candles={candles} />
<OpenPerpsPosition owner={wallet} market={market} />
<OpenPerpsMarketLauncher intent={marketCreationIntent} />
```

## Data Ownership

The host app provides market config, wallet adapter, RPC endpoint, optional theme, and optional chart data.

Chart candles come from the integrator. OpenPerps renders the chart shell and position overlays.
```

- [ ] **Step 2: Run docs grep checks**

Run:

```powershell
rg "React components provide a fast integration path" docs/react-components.md
rg "not the product|not a standalone" docs/react-components.md
```

Expected: first command finds the positive phrasing; second command finds nothing.

- [ ] **Step 3: Commit**

```powershell
git add docs/react-components.md
git commit -m "docs: define react integration contract"
```

## Task 14: Verification Pass

**Files:**
- No new files unless fixes are needed.

- [ ] **Step 1: Run SDK tests**

Run:

```powershell
cd ts/sdk
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```powershell
cd ts/frontend
npm run build
```

Expected: PASS. Existing large bundle warnings are acceptable unless new errors appear.

- [ ] **Step 3: Run indexer build**

Run:

```powershell
cd ts/indexer
npm run build --if-present
```

Expected: PASS or no-op.

- [ ] **Step 4: Check Rust tests**

Run:

```powershell
cargo test -p openperps-program
```

Expected: PASS with 24 unit tests and 29 integration tests. The previous nested `offset_of!` blocker is resolved.

- [ ] **Step 5: Check public docs constraints**

Run:

```powershell
rg "OPP|staking|revenue share|buyback" README.md docs
rg "standalone exchange frontend|not a standalone" README.md docs
rg "Devnet by default. Mainnet-capable, not production-approved" README.md docs
rg "authority-pushed oracle" README.md docs
rg "status.*off-chain|advisory" docs/market-config.md
rg "keeper signer.*oracle authority|oracle authority" docs/keeper.md docs/permissions.md
rg "clientOrderId.*client-side|not enforced on-chain" docs/trade-intent.md
rg "max_accrual_dt_slots|price-move bound|burst catch-up" docs/keeper.md docs/keeper-freshness.md
```

Expected:

- first command finds no OSS v1 token-economics claims
- second command finds no defensive standalone-exchange wording
- third command finds the approved network warning
- fourth command finds the mainnet oracle trust-model blocker wording
- fifth command confirms market status is documented as advisory/off-chain
- sixth command confirms keeper authority binding is documented
- seventh command confirms clientOrderId is documented as client-side only
- eighth command confirms keeper freshness and price-move bounds are documented

- [ ] **Step 6: Commit verification fixes**

If verification required fixes:

```powershell
git add README.md docs ts/sdk
git commit -m "chore: verify oss sdk-first docs and sdk"
```

If no fixes were needed, do not create an empty commit.

## Task 15: Next Plan Split

After this plan lands, create separate implementation plans for:

1. `@openperps/react` package extraction.
2. `@openperps/keeper` local runner.
3. Bot helper package.
4. Example implementations beyond README skeletons.
5. Optional repo folder move to `packages/` and `apps/`.

Do not start those before the SDK/docs boundary above is stable.
