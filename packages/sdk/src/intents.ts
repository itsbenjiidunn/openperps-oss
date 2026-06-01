import type { OpenPerpsRiskTier } from "./config.ts";

export type OpenPerpsTradeSide = "long" | "short";

/// An SDK-level trade order, shared by UIs, bots, DEX terminals, and backends.
/// It is not an on-chain order type: `size` is position size in base units
/// (after `sizeDecimals`), not margin, and `limitPrice` / `maxSlippageBps` /
/// `reduceOnly` are SDK-side guards rather than native on-chain semantics.
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

  const out: OpenPerpsTradeIntent = {
    schemaVersion: 1,
    marketId: expectString(value.marketId, "trade intent marketId"),
    side,
    size: expectString(value.size, "trade intent size"),
  };
  if (typeof value.limitPrice === "string") out.limitPrice = value.limitPrice;
  if (typeof value.maxSlippageBps === "number") out.maxSlippageBps = value.maxSlippageBps;
  if (typeof value.reduceOnly === "boolean") out.reduceOnly = value.reduceOnly;
  if (typeof value.clientOrderId === "string") out.clientOrderId = value.clientOrderId;
  return out;
}

export function validateMarketCreationIntent(
  value: unknown,
): OpenPerpsMarketCreationIntent {
  if (!isRecord(value)) throw new Error("invalid market creation intent");
  expectSchemaVersion(value, "market creation intent");

  const riskTier = expectString(value.riskTier, "market creation intent riskTier");
  if (riskTier !== "major" && riskTier !== "standard" && riskTier !== "experimental") {
    throw new Error(`invalid market creation intent riskTier: ${riskTier}`);
  }

  if (!isRecord(value.priceProvider)) {
    throw new Error("invalid market creation intent priceProvider");
  }
  const providerType = expectString(
    value.priceProvider.type,
    "market creation intent priceProvider.type",
  );
  if (providerType !== "external") {
    throw new Error(`invalid market creation intent priceProvider.type: ${providerType}`);
  }

  const priceProvider: OpenPerpsMarketCreationIntent["priceProvider"] = {
    type: "external",
    id: expectString(value.priceProvider.id, "market creation intent priceProvider.id"),
  };
  if (typeof value.priceProvider.description === "string") {
    priceProvider.description = value.priceProvider.description;
  }

  const out: OpenPerpsMarketCreationIntent = {
    schemaVersion: 1,
    baseMint: expectString(value.baseMint, "market creation intent baseMint"),
    quoteMint: expectString(value.quoteMint, "market creation intent quoteMint"),
    symbol: expectString(value.symbol, "market creation intent symbol"),
    initialPrice: expectString(value.initialPrice, "market creation intent initialPrice"),
    maxLeverage: expectNumber(value.maxLeverage, "market creation intent maxLeverage"),
    riskTier: riskTier as OpenPerpsRiskTier,
    priceProvider,
  };
  if (typeof value.name === "string") out.name = value.name;
  if (isRecord(value.lpVault)) {
    const lpVault: NonNullable<OpenPerpsMarketCreationIntent["lpVault"]> = {};
    if (typeof value.lpVault.initialDeposit === "string") {
      lpVault.initialDeposit = value.lpVault.initialDeposit;
    }
    out.lpVault = lpVault;
  }
  return out;
}
