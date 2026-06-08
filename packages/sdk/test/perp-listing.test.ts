import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import {
  fetchListingSignals,
  resolvePerpListing,
  buildPerpMarketListing,
  createPerpMarket,
} from "../src/perp-listing.ts";
import {
  Tag,
  RISK_TIER_STABLE,
  RISK_TIER_VOLATILE,
  ORACLE_KIND_MANUAL,
  ORACLE_KIND_DEX_EWMA,
  ORACLE_KIND_PYTH,
  usdToPriceInt,
  type FetchLike,
} from "../src/index.ts";

const programId = new PublicKey("2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4");
const authority = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const baseMint = Keypair.generate().publicKey.toBase58();
const quoteMint = Keypair.generate().publicKey.toBase58();

const memecoinSignals = { quoteDepthUsd: 3_000, fdvUsd: 5_000_000, realizedVolBpsPerMin: 4_000, ageDays: 1 };
const deepSignals = { quoteDepthUsd: 500_000, fdvUsd: 10_000_000, realizedVolBpsPerMin: 100, ageDays: 90 };

/// Tag of each program instruction; "sys" for the SystemProgram create-account.
function tagsOf(ixs: TransactionInstruction[]): (number | "sys")[] {
  return ixs.map((ix) => (ix.programId.equals(SystemProgram.programId) ? "sys" : ix.data[0]!));
}
function initMarketOf(ixs: TransactionInstruction[]): TransactionInstruction {
  const im = ixs.find((ix) => ix.programId.equals(programId) && ix.data[0] === Tag.InitMarket);
  if (!im) throw new Error("no InitMarket instruction");
  return im;
}
function okJson(body: unknown): ReturnType<FetchLike> {
  return Promise.resolve({ ok: true, async json() { return body; } });
}

// --- fetchListingSignals ---

test("fetchListingSignals maps the deepest Solana pair", async () => {
  const now = Date.now();
  const fetchImpl: FetchLike = () =>
    okJson({
      pairs: [
        { chainId: "ethereum", priceUsd: "5", liquidity: { usd: 1e9 } }, // wrong chain
        {
          chainId: "solana",
          priceUsd: "0.5",
          liquidity: { usd: 1_000 },
          fdv: 100_000,
          pairCreatedAt: now - 2 * 86_400_000,
          priceChange: { m5: 30 },
          baseToken: { symbol: "FOO" },
          dexId: "raydium",
          pairAddress: "POOL1",
        },
        {
          chainId: "solana",
          priceUsd: "0.6",
          liquidity: { usd: 80_000 }, // deepest -> wins
          fdv: 120_000,
          pairCreatedAt: now - 30 * 86_400_000,
          priceChange: { m5: 1 },
          baseToken: { symbol: "FOO" },
          dexId: "raydium",
          pairAddress: "POOL2",
        },
      ],
    });
  const ls = await fetchListingSignals("MINT", { fetchImpl });
  assert.ok(ls);
  assert.equal(ls.priceUsd, 0.6);
  assert.equal(ls.signals.quoteDepthUsd, 80_000);
  assert.equal(ls.signals.fdvUsd, 120_000);
  assert.equal(ls.signals.realizedVolBpsPerMin, (1 / 5) * 100); // |m5| over 5min, in bps
  assert.ok(ls.signals.ageDays! >= 29 && ls.signals.ageDays! <= 31);
  assert.equal(ls.symbol, "FOO");
  assert.equal(ls.dex, "raydium");
  assert.equal(ls.poolAddress, "POOL2");
});

test("fetchListingSignals returns null when no usable Solana pair", async () => {
  const fetchImpl: FetchLike = () => okJson({ pairs: [{ chainId: "ethereum", priceUsd: "1" }] });
  assert.equal(await fetchListingSignals("MINT", { fetchImpl }), null);
});

// --- resolvePerpListing (classifier -> intent) ---

test("resolve: thin/new/high-vol token -> Volatile + MANUAL + 5x + experimental", () => {
  const r = resolvePerpListing({
    baseMint,
    quoteMint,
    signals: memecoinSignals,
    priceUsd: 0.0001234,
    symbol: "PUMP",
  });
  assert.equal(r.riskTierCode, RISK_TIER_VOLATILE);
  assert.equal(r.suggestedOracleKind, ORACLE_KIND_MANUAL);
  assert.equal(r.maxLeverage, 5);
  assert.equal(r.intent.riskTier, "experimental");
  assert.equal(r.priceInt, usdToPriceInt(0.0001234, 6));
  assert.equal(r.intent.initialPrice, usdToPriceInt(0.0001234, 6).toString());
});

test("resolve: deep/mature/low-vol token -> Stable + DEX_EWMA + 10x + standard", () => {
  const r = resolvePerpListing({ baseMint, quoteMint, signals: deepSignals, priceUsd: 2, symbol: "DEEP" });
  assert.equal(r.riskTierCode, RISK_TIER_STABLE);
  assert.equal(r.suggestedOracleKind, ORACLE_KIND_DEX_EWMA);
  assert.equal(r.maxLeverage, 10);
  assert.equal(r.intent.riskTier, "standard");
});

test("resolve: token with a Pyth feed -> PYTH + major", () => {
  const r = resolvePerpListing({
    baseMint,
    quoteMint,
    signals: { quoteDepthUsd: 2_000_000, fdvUsd: 1e9, realizedVolBpsPerMin: 50, ageDays: 365, hasPythFeed: true },
    priceUsd: 150,
    symbol: "SOL",
  });
  assert.equal(r.suggestedOracleKind, ORACLE_KIND_PYTH);
  assert.equal(r.intent.riskTier, "major");
  assert.equal(r.riskTierCode, RISK_TIER_STABLE);
});

// --- buildPerpMarketListing (build-only instruction emission) ---

test("build: memecoin emits the lifecycle + SetHouseCap, MANUAL, Volatile", () => {
  const listing = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: memecoinSignals,
    priceUsd: 0.01,
    symbol: "PUMP",
    programId,
    authority,
    market,
    marketRentLamports: 1_000_000,
    houseCapBase: 500_000n,
  });
  assert.deepEqual(tagsOf(listing.instructions), [
    "sys",
    Tag.InitMarket,
    Tag.CreateVault,
    Tag.CreateHouseVault,
    Tag.ActivateMarket,
    Tag.SetOracleAuthority, // MANUAL market names its own relayer key
    Tag.SetHouseCap,
  ]);
  assert.equal(listing.oracleKind, ORACLE_KIND_MANUAL);
  assert.equal(listing.resolved.riskTierCode, RISK_TIER_VOLATILE);
  const im = initMarketOf(listing.instructions);
  assert.equal(im.data[70], ORACLE_KIND_MANUAL); // oracle_kind byte
  assert.equal(im.data[135], RISK_TIER_VOLATILE); // risk_tier byte
  assert.equal(listing.config.market, market.toBase58());
  assert.equal(listing.config.programId, programId.toBase58());
  assert.equal(listing.config.maxLeverage, 5);
  assert.equal(listing.config.riskTier, "experimental");
  assert.equal(listing.config.symbol, "PUMP");
});

test("build: a House deposit inserts FundHouseVault (needs authorityQuoteToken)", () => {
  const authorityQuoteToken = Keypair.generate().publicKey;
  const listing = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: memecoinSignals,
    priceUsd: 0.01,
    symbol: "PUMP",
    programId,
    authority,
    market,
    marketRentLamports: 1,
    initialHouseDepositAtoms: "1000000",
    authorityQuoteToken,
  });
  assert.deepEqual(tagsOf(listing.instructions), [
    "sys",
    Tag.InitMarket,
    Tag.CreateVault,
    Tag.CreateHouseVault,
    Tag.FundHouseVault,
    Tag.ActivateMarket,
    Tag.SetOracleAuthority,
  ]);
});

test("listing sets a MANUAL market's oracle authority; verifiable markets skip it", () => {
  // MANUAL (memecoin): names its own relayer key, defaulting to the authority.
  const keeper = Keypair.generate().publicKey;
  const manual = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: memecoinSignals,
    priceUsd: 0.01,
    symbol: "PUMP",
    programId,
    authority,
    market,
    marketRentLamports: 1,
    oracleAuthority: keeper,
  });
  assert.ok(tagsOf(manual.instructions).includes(Tag.SetOracleAuthority));

  // DEX_EWMA (verifiable, deep pool): priced by its crank, so no oracle authority
  // is added unless one is explicitly requested.
  const verifiable = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: deepSignals,
    priceUsd: 2,
    symbol: "DEEP",
    programId,
    authority,
    market,
    marketRentLamports: 1,
    oraclePool: Keypair.generate().publicKey,
  });
  assert.equal(verifiable.oracleKind, ORACLE_KIND_DEX_EWMA);
  assert.ok(!tagsOf(verifiable.instructions).includes(Tag.SetOracleAuthority));
});

test("build: a verifiable suggestion falls back to MANUAL without a binding", () => {
  const noPool = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: deepSignals,
    priceUsd: 2,
    symbol: "DEEP",
    programId,
    authority,
    market,
    marketRentLamports: 1,
  });
  assert.equal(noPool.resolved.suggestedOracleKind, ORACLE_KIND_DEX_EWMA);
  assert.equal(noPool.oracleKind, ORACLE_KIND_MANUAL); // no pool supplied -> MANUAL
  assert.equal(initMarketOf(noPool.instructions).data[70], ORACLE_KIND_MANUAL);

  const withPool = buildPerpMarketListing({
    baseMint,
    quoteMint,
    signals: deepSignals,
    priceUsd: 2,
    symbol: "DEEP",
    programId,
    authority,
    market,
    marketRentLamports: 1,
    oraclePool: Keypair.generate().publicKey,
  });
  assert.equal(withPool.oracleKind, ORACLE_KIND_DEX_EWMA);
  assert.equal(initMarketOf(withPool.instructions).data[70], ORACLE_KIND_DEX_EWMA);
});

// --- createPerpMarket (one-call) ---

test("createPerpMarket: fetch -> classify -> build, for a memecoin", async () => {
  const fetchImpl: FetchLike = () =>
    okJson({
      pairs: [
        {
          chainId: "solana",
          priceUsd: "0.02",
          liquidity: { usd: 4_000 },
          fdv: 8_000_000,
          pairCreatedAt: Date.now() - 86_400_000,
          priceChange: { m5: 50 },
          baseToken: { symbol: "MEME" },
          dexId: "pumpswap",
          pairAddress: "PL",
        },
      ],
    });
  const listing = await createPerpMarket({
    baseMint,
    quoteMint,
    programId,
    authority,
    market,
    marketRentLamports: 1,
    fetchImpl,
    houseCapBase: 1_000n,
  });
  assert.equal(listing.config.symbol, "MEME");
  assert.equal(listing.config.dex, "pumpswap");
  assert.equal(listing.config.poolAddress, "PL");
  assert.equal(listing.oracleKind, ORACLE_KIND_MANUAL);
  assert.equal(listing.resolved.riskTierCode, RISK_TIER_VOLATILE);
  assert.ok(tagsOf(listing.instructions).includes(Tag.SetHouseCap));
});

test("createPerpMarket: throws when no off-chain price is found", async () => {
  const fetchImpl: FetchLike = () => Promise.resolve({ ok: false, async json() { return {}; } });
  await assert.rejects(
    () =>
      createPerpMarket({
        baseMint,
        quoteMint,
        programId,
        authority,
        market,
        marketRentLamports: 1,
        fetchImpl,
      }),
    /no off-chain signals/,
  );
});
