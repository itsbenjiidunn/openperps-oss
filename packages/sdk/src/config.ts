export type OpenPerpsCluster = "devnet" | "mainnet-beta";
export type OpenPerpsRiskTier = "major" | "standard" | "experimental";
export type OpenPerpsMarketStatus =
  | "draft"
  | "active"
  | "paused"
  | "close-only"
  | "settled";

/// A portable description of one OpenPerps market. `status`, `maxLeverage`, and
/// the `*Decimals` fields are off-chain integration metadata: the engine
/// enforces its own margin/risk constraints and uses fixed internal scales, so
/// SDK helpers map user-facing units into engine atoms and treat `status` as an
/// advisory hint, not an on-chain guarantee.
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
    throw new Error(
      `unsupported market config schemaVersion: ${String(value.schemaVersion)}`,
    );
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

  // Build with required fields only, then attach optionals when present, so the
  // result never carries `undefined`-valued keys (keeps it deep-equal to a
  // minimal input and clean to serialize).
  const out: OpenPerpsMarketConfig = {
    schemaVersion: 1,
    id: expectString(value.id, "id"),
    cluster: cluster as OpenPerpsCluster,
    programId: expectString(value.programId, "programId"),
    market: expectString(value.market, "market"),
    assetIndex: expectNumber(value.assetIndex, "assetIndex"),
    baseMint: expectString(value.baseMint, "baseMint"),
    quoteMint: expectString(value.quoteMint, "quoteMint"),
    symbol: expectString(value.symbol, "symbol"),
    priceDecimals: expectNumber(value.priceDecimals, "priceDecimals"),
    sizeDecimals: expectNumber(value.sizeDecimals, "sizeDecimals"),
    quoteDecimals: expectNumber(value.quoteDecimals, "quoteDecimals"),
    riskTier: riskTier as OpenPerpsRiskTier,
    maxLeverage: expectNumber(value.maxLeverage, "maxLeverage"),
    status: status as OpenPerpsMarketStatus,
  };

  if (typeof value.name === "string") out.name = value.name;
  if (typeof value.poolAddress === "string") out.poolAddress = value.poolAddress;
  if (typeof value.dex === "string") out.dex = value.dex;
  if (typeof value.createdBy === "string") out.createdBy = value.createdBy;

  if (isRecord(value.keeper)) {
    const keeper: NonNullable<OpenPerpsMarketConfig["keeper"]> = {};
    if (typeof value.keeper.oracleAuthority === "string") {
      keeper.oracleAuthority = value.keeper.oracleAuthority;
    }
    if (typeof value.keeper.expectedCrankIntervalMs === "number") {
      keeper.expectedCrankIntervalMs = value.keeper.expectedCrankIntervalMs;
    }
    out.keeper = keeper;
  }

  if (isRecord(value.metadata)) {
    const metadata: NonNullable<OpenPerpsMarketConfig["metadata"]> = {};
    if (typeof value.metadata.logoURI === "string") {
      metadata.logoURI = value.metadata.logoURI;
    }
    if (typeof value.metadata.website === "string") {
      metadata.website = value.metadata.website;
    }
    if (Array.isArray(value.metadata.tags)) {
      metadata.tags = value.metadata.tags.filter(
        (tag): tag is string => typeof tag === "string",
      );
    }
    out.metadata = metadata;
  }

  return out;
}

/// An in-memory registry backed by a static list. Every config is validated
/// once on construction. Use this for bundled official markets, a launchpad's
/// own token list, or a bot loading config from JSON.
export function createJsonMarketRegistry(
  markets: OpenPerpsMarketConfig[],
): MarketRegistryProvider {
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
