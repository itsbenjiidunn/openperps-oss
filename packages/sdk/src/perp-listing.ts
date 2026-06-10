/// One-call perp listing for any Solana token. Given a token mint, this resolves
/// the off-chain signals (depth, FDV, age, realized vol) from DexScreener, runs
/// the pump-dump classifier to pick a risk tier and oracle posture, scales the
/// live price into the market's mark decimals, and emits every instruction to
/// stand up a usable market (account, InitMarket at the chosen tier, vault,
/// House, optional House funding, ActivateMarket, and the House / deposit caps).
///
/// It is build-only: it performs the off-chain price/signals reads (an injectable
/// `fetch`) and returns instructions plus a portable `OpenPerpsMarketConfig`. The
/// caller supplies the market account rent (one RPC call) and a fresh market
/// keypair, then signs and sends. No private keys, no on-chain reads here.

import {
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  classifyMarketTier,
  type ClassifyThresholds,
  type MarketClassification,
  type MarketSignals,
} from "./classify.ts";
import {
  ORACLE_KIND_DEX_EWMA,
  ORACLE_KIND_MANUAL,
  ORACLE_KIND_PYTH,
  RISK_TIER_VOLATILE,
} from "./layout.ts";
import {
  buildMarketCreationInstructions,
  type MarketCreationBuild,
} from "./market-create-build.ts";
import {
  depositCapPda,
  feeConfigPda,
  houseCapPda,
  oracleAuthorityPda,
  setDepositCapIx,
  setHouseCapIx,
  setMarketFeeIx,
  setOracleAuthorityIx,
} from "./instructions.ts";
import type { OpenPerpsMarketCreationIntent } from "./intents.ts";
import type { OpenPerpsCluster, OpenPerpsMarketConfig, OpenPerpsRiskTier } from "./config.ts";
import { usdToPriceInt, type FetchLike } from "./price.ts";

/// Off-chain signals plus the live price for a token, as read from an aggregator.
export type ListingSignals = {
  signals: MarketSignals;
  priceUsd: number;
  symbol?: string;
  poolAddress?: string;
  dex?: string;
};

export type FetchListingSignalsOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/// Read DexScreener for `mint` and map the deepest Solana pair into the
/// classifier's `MarketSignals` plus the live USD price. Returns null when no
/// usable Solana pair is found. `quoteDepthUsd` uses the pair's USD liquidity (a
/// liquidation executes against pool depth); `realizedVolBpsPerMin` is estimated
/// from the short-window price change; `ageDays` from the pair creation time.
/// LP-lock, holder concentration, and Pyth availability are not on DexScreener,
/// so they stay undefined and the classifier treats them conservatively.
export async function fetchListingSignals(
  mint: string,
  options: FetchListingSignalsOptions = {},
): Promise<ListingSignals | null> {
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    throw new Error("fetchListingSignals: no fetch available; pass options.fetchImpl");
  }
  const json = await fetchJsonOrNull(
    fetchImpl,
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    options.timeoutMs ?? 6_000,
  );
  if (json === null) return null;

  const pair = deepestSolanaPair(json);
  if (!pair) return null;

  const priceUsd = Number(pair.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const signals: MarketSignals = {};
  const depth = Number(pair.liquidity?.usd);
  if (Number.isFinite(depth) && depth > 0) signals.quoteDepthUsd = depth;
  const fdv = Number(pair.fdv);
  if (Number.isFinite(fdv) && fdv > 0) signals.fdvUsd = fdv;
  const vol = realizedVolBpsPerMin(pair.priceChange);
  if (vol !== undefined) signals.realizedVolBpsPerMin = vol;
  const age = ageDays(pair.pairCreatedAt);
  if (age !== undefined) signals.ageDays = age;

  const out: ListingSignals = { signals, priceUsd };
  if (pair.baseToken?.symbol) out.symbol = pair.baseToken.symbol;
  if (pair.pairAddress) out.poolAddress = pair.pairAddress;
  if (pair.dexId) out.dex = pair.dexId;
  return out;
}

export type ResolvePerpListingInput = {
  baseMint: string;
  quoteMint: string;
  signals: MarketSignals;
  priceUsd: number;
  symbol: string;
  name?: string;
  /// Mark price scale (integer decimals). Default 6 (mUSDC scale).
  priceDecimals?: number;
  sizeDecimals?: number;
  quoteDecimals?: number;
  /// Initial House (LP) deposit in quote atoms, if the authority seeds the House.
  initialHouseDepositAtoms?: string;
  thresholds?: Partial<ClassifyThresholds>;
  /// Identifier recorded as the market's price provider (the keeper/relayer that
  /// will feed it). Default "openperps-live".
  priceProviderId?: string;
};

export type ResolvedPerpListing = {
  classification: MarketClassification;
  intent: OpenPerpsMarketCreationIntent;
  /// On-chain `risk_tier` code (STABLE / VOLATILE).
  riskTierCode: number;
  /// Classifier-suggested `oracle_kind` (may need a feed/pool to actually use).
  suggestedOracleKind: number;
  maxLeverage: number;
  priceDecimals: number;
  /// Initial mark price as the scaled integer the program expects.
  priceInt: bigint;
};

/// Map a token's off-chain signals into a complete, conservative listing: the
/// pump-dump classifier picks the tier and oracle posture, and this fixes the
/// user-facing leverage and risk-tier metadata. Pure (no network).
export function resolvePerpListing(input: ResolvePerpListingInput): ResolvedPerpListing {
  const priceDecimals = input.priceDecimals ?? 6;
  const classification = classifyMarketTier(input.signals, input.thresholds);
  const isVolatile = classification.riskTierCode === RISK_TIER_VOLATILE;
  // Leverage mirrors the on-chain tier envelope: Volatile caps lower.
  const maxLeverage = isVolatile ? 5 : 10;
  const priceInt = usdToPriceInt(input.priceUsd, priceDecimals);
  if (priceInt <= 0n) {
    throw new Error(`resolvePerpListing: non-positive price for ${input.symbol}`);
  }

  // Off-chain risk-tier metadata: a Pyth-grade token is "major", a Stable
  // non-Pyth token "standard", anything Volatile "experimental".
  const tierName: OpenPerpsRiskTier =
    classification.suggestedOracleKind === ORACLE_KIND_PYTH
      ? "major"
      : classification.riskTier === "stable"
        ? "standard"
        : "experimental";

  const intent: OpenPerpsMarketCreationIntent = {
    schemaVersion: 1,
    baseMint: input.baseMint,
    quoteMint: input.quoteMint,
    symbol: input.symbol,
    initialPrice: priceInt.toString(),
    maxLeverage,
    riskTier: tierName,
    priceProvider: {
      type: "external",
      id: input.priceProviderId ?? "openperps-live",
      description: `${classification.oraclePosture} (oracle_kind ${classification.suggestedOracleKind})`,
    },
  };
  if (input.name !== undefined) intent.name = input.name;
  if (input.initialHouseDepositAtoms !== undefined) {
    intent.lpVault = { initialDeposit: input.initialHouseDepositAtoms };
  }

  return {
    classification,
    intent,
    riskTierCode: classification.riskTierCode,
    suggestedOracleKind: classification.suggestedOracleKind,
    maxLeverage,
    priceDecimals,
    priceInt,
  };
}

export type BuildPerpMarketListingInput = ResolvePerpListingInput & {
  programId: PublicKey;
  authority: PublicKey;
  /// A fresh keypair public key for the market account (caller signs with it).
  market: PublicKey;
  /// Rent-exempt lamports for the market account, from
  /// `getMinimumBalanceForRentExemption(marketAccountSize(capacity))`.
  marketRentLamports: number;
  assetSlotCapacity?: number;
  assetIndex?: number;
  cluster?: OpenPerpsCluster;
  /// Authority's quote-mint token account, required when seeding the House.
  authorityQuoteToken?: PublicKey;
  /// Pyth feed id (32 bytes) when the listing should price off Pyth.
  oracleFeedId?: Uint8Array;
  /// DEX pool when the listing should price off a DEX-EWMA crank.
  oraclePool?: PublicKey;
  /// The market's oracle authority: the key (the integrator's relayer/keeper)
  /// allowed to move the mark via AccrueAsset. A production program has no shared
  /// relayer key, so a MANUAL (memecoin) market must name its own here or its
  /// mark stays frozen. Defaults to the market `authority`. Verifiable markets
  /// (PYTH / DEX_EWMA) are priced by their crank and ignore this.
  oracleAuthority?: PublicKey;
  /// Append SetHouseCap with this max net House position (base units).
  houseCapBase?: bigint;
  /// Append SetDepositCap with this per-portfolio cap (quote atoms). DEX-priced
  /// markets only; raises above the program floor.
  depositCapAtoms?: bigint;
  /// Append SetMarketFee with this trading-fee floor (min `fee_bps` per trade
  /// leg), so no one can craft a 0-fee trade on this market. Omit / 0 for no floor.
  minFeeBps?: bigint;
  /// Carried into the returned config for the registry.
  poolAddress?: string;
  dex?: string;
};

export type PerpMarketListing = MarketCreationBuild & {
  instructions: TransactionInstruction[];
  resolved: ResolvedPerpListing;
  /// The `oracle_kind` actually used on-chain. Falls back to MANUAL when the
  /// classifier suggested a verifiable feed but no feed id / pool was supplied.
  oracleKind: number;
  /// A portable config for the SDK registry / keeper, with the real market key.
  config: OpenPerpsMarketConfig;
};

/// Resolve and emit every instruction to list a perp on a token, build-only. The
/// returned `instructions` are ordered and ready to sign (the market keypair and
/// the authority must both sign).
export function buildPerpMarketListing(input: BuildPerpMarketListingInput): PerpMarketListing {
  const resolved = resolvePerpListing(input);
  const assetIndex = input.assetIndex ?? 0;
  const assetSlotCapacity = input.assetSlotCapacity ?? 1;

  // A verifiable oracle needs its binding; without it, stay MANUAL (and so
  // require_verifiable stays off) rather than init a feed-less verifiable market.
  let oracleKind = resolved.suggestedOracleKind;
  if (oracleKind === ORACLE_KIND_PYTH && !input.oracleFeedId) oracleKind = ORACLE_KIND_MANUAL;
  if (oracleKind === ORACLE_KIND_DEX_EWMA && !input.oraclePool) oracleKind = ORACLE_KIND_MANUAL;

  const build = buildMarketCreationInstructions({
    intent: resolved.intent,
    programId: input.programId,
    authority: input.authority,
    market: input.market,
    marketRentLamports: input.marketRentLamports,
    assetSlotCapacity,
    assetIndex,
    ...(input.authorityQuoteToken ? { authorityQuoteToken: input.authorityQuoteToken } : {}),
    oracleKind,
    ...(input.oracleFeedId ? { oracleFeedId: input.oracleFeedId } : {}),
    ...(input.oraclePool ? { oraclePool: input.oraclePool } : {}),
    riskTier: resolved.riskTierCode,
  });

  const instructions = [...build.instructions];

  // A MANUAL (relayer) market must name its own oracle authority: a production
  // program has no shared relayer key, so without this its mark stays frozen.
  // Default it to the market authority; an integrator passes its keeper key.
  // Verifiable markets (PYTH / DEX_EWMA) are priced by their crank, so this is
  // only added for them when an authority is explicitly requested.
  if (oracleKind === ORACLE_KIND_MANUAL || input.oracleAuthority !== undefined) {
    const newAuthority = input.oracleAuthority ?? input.authority;
    const [pda, bump] = oracleAuthorityPda(input.programId, input.market);
    instructions.push(
      setOracleAuthorityIx({
        programId: input.programId,
        oracleAuthorityPda: pda,
        market: input.market,
        authority: input.authority,
        newAuthority,
        bump,
      }),
    );
  }

  if (input.houseCapBase !== undefined) {
    const [pda, bump] = houseCapPda(input.programId, input.market);
    instructions.push(
      setHouseCapIx({
        programId: input.programId,
        houseCapPda: pda,
        market: input.market,
        authority: input.authority,
        maxBasePosition: input.houseCapBase,
        bump,
      }),
    );
  }
  if (input.depositCapAtoms !== undefined) {
    const [pda, bump] = depositCapPda(input.programId, input.market);
    instructions.push(
      setDepositCapIx({
        programId: input.programId,
        depositCapPda: pda,
        market: input.market,
        authority: input.authority,
        maxCapital: input.depositCapAtoms,
        bump,
      }),
    );
  }
  if (input.minFeeBps !== undefined && input.minFeeBps > 0n) {
    const [pda, bump] = feeConfigPda(input.programId, input.market);
    instructions.push(
      setMarketFeeIx({
        programId: input.programId,
        feeConfigPda: pda,
        market: input.market,
        authority: input.authority,
        minFeeBps: input.minFeeBps,
        bump,
      }),
    );
  }

  const config: OpenPerpsMarketConfig = {
    schemaVersion: 1,
    id: input.market.toBase58(),
    cluster: input.cluster ?? "devnet",
    programId: input.programId.toBase58(),
    market: input.market.toBase58(),
    assetIndex,
    baseMint: input.baseMint,
    quoteMint: input.quoteMint,
    symbol: input.symbol,
    priceDecimals: resolved.priceDecimals,
    sizeDecimals: input.sizeDecimals ?? 6,
    quoteDecimals: input.quoteDecimals ?? 6,
    riskTier: resolved.intent.riskTier,
    maxLeverage: resolved.maxLeverage,
    status: "active",
  };
  if (input.name !== undefined) config.name = input.name;
  if (input.poolAddress !== undefined) config.poolAddress = input.poolAddress;
  if (input.dex !== undefined) config.dex = input.dex;

  return { ...build, instructions, resolved, oracleKind, config };
}

export type CreatePerpMarketInput = Omit<
  BuildPerpMarketListingInput,
  "signals" | "priceUsd" | "symbol"
> & {
  /// Pre-fetched signals (skips the network read; for tests or a cache).
  signals?: ListingSignals;
  /// Override the symbol; defaults to the aggregator's, then the mint prefix.
  symbol?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/// The one-call listing: read live signals for `baseMint`, classify, and build
/// every instruction to stand up the market. Supply the market account rent (one
/// RPC call) and a fresh market keypair; sign and send the returned instructions.
export async function createPerpMarket(input: CreatePerpMarketInput): Promise<PerpMarketListing> {
  const ls =
    input.signals ??
    (await fetchListingSignals(input.baseMint, {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }));
  if (!ls) {
    throw new Error(`createPerpMarket: no off-chain signals/price for ${input.baseMint}`);
  }

  return buildPerpMarketListing({
    ...input,
    signals: ls.signals,
    priceUsd: ls.priceUsd,
    symbol: input.symbol ?? ls.symbol ?? input.baseMint.slice(0, 6),
    ...(input.poolAddress === undefined && ls.poolAddress ? { poolAddress: ls.poolAddress } : {}),
    ...(input.dex === undefined && ls.dex ? { dex: ls.dex } : {}),
  });
}

// --- internal helpers ---

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
  baseToken?: { symbol?: string };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
};

function deepestSolanaPair(json: unknown): DexPair | null {
  const pairs = (json as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return null;
  let best: { liq: number; pair: DexPair } | null = null;
  for (const raw of pairs as DexPair[]) {
    if (raw.chainId !== "solana") continue;
    const price = Number(raw.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const liq = Number(raw.liquidity?.usd) || 0;
    if (!best || liq > best.liq) best = { liq, pair: raw };
  }
  return best?.pair ?? null;
}

/// Estimate realized vol (bps per minute) from the shortest available price
/// change window: |move%| over the window, per minute, times 100 bps per percent.
function realizedVolBpsPerMin(pc: DexPair["priceChange"]): number | undefined {
  if (!pc) return undefined;
  const windows: [number | undefined, number][] = [
    [pc.m5, 5],
    [pc.h1, 60],
    [pc.h6, 360],
    [pc.h24, 1440],
  ];
  for (const [change, minutes] of windows) {
    if (typeof change === "number" && Number.isFinite(change)) {
      return (Math.abs(change) / minutes) * 100;
    }
  }
  return undefined;
}

function ageDays(pairCreatedAt: number | undefined): number | undefined {
  if (typeof pairCreatedAt !== "number" || !Number.isFinite(pairCreatedAt) || pairCreatedAt <= 0) {
    return undefined;
  }
  const ms = Date.now() - pairCreatedAt;
  if (ms < 0) return 0;
  return ms / 86_400_000;
}

async function fetchJsonOrNull(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
