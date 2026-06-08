// Instruction encoders mirroring Rust `crates/program/src/instruction.rs`.
// Wire format: 1-byte tag followed by little-endian payload.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  DEPOSIT_CAP_SEED,
  DEXPOOL_SEED,
  HLP_POSITION_SEED,
  HLP_SEED,
  HLP_VAULT_SEED,
  HOUSE_CAP_SEED,
  HOUSE_SEED,
  INSURANCE_CFG_SEED,
  ORACLE_SEED,
  PORTFOLIO_SEED,
  RISK_TIER_STABLE,
  TWAP_SEED,
} from "./layout.ts";

export { TOKEN_PROGRAM_ID };

export const Tag = {
  InitMarket: 0,
  InitPortfolio: 1,
  Deposit: 2,
  ActivateMarket: 3,
  AccrueAsset: 4,
  Trade: 5,
  CreateVault: 6,
  Withdraw: 7,
  Liquidate: 8,
  ResolveMarket: 9,
  CrankRefresh: 10,
  CreateHouseVault: 11,
  FundHouseVault: 12,
  WithdrawHouseVault: 13,
  PlaceOrder: 14,
  CreateMockPool: 15,
  MockSwap: 16,
  CrankOracle: 17,
  PinOraclePool: 18,
  SetDelegate: 19,
  SettlePnl: 20,
  SetOracleAuthority: 21,
  SetDepositCap: 22,
  CrankPyth: 23,
  SetDexPool: 24,
  CrankDexSpot: 25,
  PlaceBatchOrder: 26,
  SetHouseCap: 27,
  SetRequireVerifiable: 28,
  FundInsurance: 29,
  SetInsuranceParams: 30,
  RequestInsuranceWithdraw: 31,
  ExecuteInsuranceWithdraw: 32,
  CreateHlpVault: 33,
  SetHlpParams: 34,
  DepositHlp: 35,
  DeployHlp: 36,
  RequestRedeemHlp: 37,
  ExecuteRedeemHlp: 38,
  HarvestHlp: 39,
} as const;

/// Side encoding for `PlaceOrder`.
export const Side = {
  Long: 0,
  Short: 1,
} as const;
export type Side = (typeof Side)[keyof typeof Side];

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffff_ffff)
    throw new Error(`u32 out of range: ${value}`);
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value >= 1n << 64n)
    throw new Error(`u64 out of range: ${value}`);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value >= 1n << 128n)
    throw new Error(`u128 out of range: ${value}`);
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Write a signed 128-bit little-endian (two's complement) integer. */
function writeI128LE(buf: Uint8Array, offset: number, value: bigint): void {
  const MIN = -(1n << 127n);
  const MAX = (1n << 127n) - 1n;
  if (value < MIN || value > MAX)
    throw new Error(`i128 out of range: ${value}`);
  const unsigned = value < 0n ? value + (1n << 128n) : value;
  writeU128LE(buf, offset, unsigned);
}

function expect32(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.length !== 32)
    throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

export function encodeInitMarket(
  marketGroupId: Uint8Array,
  assetSlotCapacity: number,
  vaultBump: number,
  baseMint: Uint8Array,
  oracleKind: number,
  oracleFeedId: Uint8Array,
  oraclePool: Uint8Array,
  riskTier: number,
): Buffer {
  expect32(marketGroupId, "marketGroupId");
  expect32(baseMint, "baseMint");
  expect32(oracleFeedId, "oracleFeedId");
  expect32(oraclePool, "oraclePool");
  if (vaultBump < 0 || vaultBump > 255) {
    throw new Error(`vaultBump out of range: ${vaultBump}`);
  }
  if (oracleKind < 0 || oracleKind > 255) {
    throw new Error(`oracleKind out of range: ${oracleKind}`);
  }
  if (riskTier < 0 || riskTier > 255) {
    throw new Error(`riskTier out of range: ${riskTier}`);
  }
  // tag(1) + marketGroupId(32) + capacity(4) + vaultBump(1)
  //   + baseMint(32) + oracleKind(1) + oracleFeedId(32) + oraclePool(32)
  //   + riskTier(1)
  const data = new Uint8Array(1 + 32 + 4 + 1 + 32 + 1 + 32 + 32 + 1);
  data[0] = Tag.InitMarket;
  data.set(marketGroupId, 1);
  writeU32LE(data, 33, assetSlotCapacity);
  data[37] = vaultBump;
  data.set(baseMint, 38);
  data[70] = oracleKind;
  data.set(oracleFeedId, 71);
  data.set(oraclePool, 103);
  data[135] = riskTier;
  return Buffer.from(data);
}

export function encodeCreateMockPool(
  reserveBase: bigint,
  reserveQuote: bigint,
): Buffer {
  const data = new Uint8Array(1 + 8 + 8);
  data[0] = Tag.CreateMockPool;
  writeU64LE(data, 1, reserveBase);
  writeU64LE(data, 9, reserveQuote);
  return Buffer.from(data);
}

export function encodeMockSwap(amountIn: bigint, baseToQuote: boolean): Buffer {
  const data = new Uint8Array(1 + 8 + 1);
  data[0] = Tag.MockSwap;
  writeU64LE(data, 1, amountIn);
  data[9] = baseToQuote ? 1 : 0;
  return Buffer.from(data);
}

export function encodeCrankOracle(assetIndex: number): Buffer {
  const data = new Uint8Array(1 + 4);
  data[0] = Tag.CrankOracle;
  writeU32LE(data, 1, assetIndex);
  return Buffer.from(data);
}

export function encodePinOraclePool(assetIndex: number): Buffer {
  const data = new Uint8Array(1 + 4);
  data[0] = Tag.PinOraclePool;
  writeU32LE(data, 1, assetIndex);
  return Buffer.from(data);
}

export function encodeSettlePnl(): Buffer {
  return Buffer.from([Tag.SettlePnl]);
}

export function encodeInitPortfolio(bump: number): Buffer {
  const data = new Uint8Array(1 + 1);
  data[0] = Tag.InitPortfolio;
  data[1] = bump & 0xff;
  return Buffer.from(data);
}

export function encodeDeposit(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.Deposit;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

export function encodeActivateMarket(
  assetIndex: number,
  authenticatedPrice: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 8);
  data[0] = Tag.ActivateMarket;
  writeU32LE(data, 1, assetIndex);
  writeU64LE(data, 5, authenticatedPrice);
  return Buffer.from(data);
}

export function encodeAccrueAsset(
  assetIndex: number,
  effectivePrice: bigint,
  fundingRateE9: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 8 + 16);
  data[0] = Tag.AccrueAsset;
  writeU32LE(data, 1, assetIndex);
  writeU64LE(data, 5, effectivePrice);
  writeI128LE(data, 13, fundingRateE9);
  return Buffer.from(data);
}

export function encodeCreateVault(): Buffer {
  return Buffer.from([Tag.CreateVault]);
}

export function encodeWithdraw(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.Withdraw;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

export function encodeLiquidate(
  assetIndex: number,
  closeQ: bigint,
  feeBps: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 16 + 8);
  data[0] = Tag.Liquidate;
  writeU32LE(data, 1, assetIndex);
  writeU128LE(data, 5, closeQ);
  writeU64LE(data, 21, feeBps);
  return Buffer.from(data);
}

export function encodeResolveMarket(): Buffer {
  return Buffer.from([Tag.ResolveMarket]);
}

export function encodeCrankRefresh(
  assetIndex: number,
  effectivePrice: bigint,
  fundingRateE9: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 8 + 16);
  data[0] = Tag.CrankRefresh;
  writeU32LE(data, 1, assetIndex);
  writeU64LE(data, 5, effectivePrice);
  writeI128LE(data, 13, fundingRateE9);
  return Buffer.from(data);
}

export function encodeTrade(
  assetIndex: number,
  sizeQ: bigint,
  execPrice: bigint,
  feeBps: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 16 + 8 + 8);
  data[0] = Tag.Trade;
  writeU32LE(data, 1, assetIndex);
  writeU128LE(data, 5, sizeQ);
  writeU64LE(data, 21, execPrice);
  writeU64LE(data, 29, feeBps);
  return Buffer.from(data);
}

// ---------- TransactionInstruction builders ----------

export function initMarketIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  quoteMint: PublicKey;
  marketGroupId: Uint8Array;
  assetSlotCapacity: number;
  vaultBump: number;
  /// Underlying asset's SPL mint; pass the all-zero pubkey for a synthetic
  /// (BTC/ETH have no mint on Solana).
  baseMint: PublicKey;
  /// 0 = manual, 1 = Pyth feed, 2 = DEX-EWMA pool. See `ORACLE_KIND_*`.
  oracleKind: number;
  /// 32-byte Pyth feed id; all-zero for non-Pyth markets.
  oracleFeedId: Uint8Array;
  /// DEX pool account read by CrankOracle; all-zero unless DEX-EWMA.
  oraclePool: PublicKey;
  /// Risk tier: 0 = Stable (deep-pool / major, 10x, cheap keeper), 1 = Volatile
  /// (pump-dump, wide clamp + short accrual window, 5x, frequent pushes). See
  /// `RISK_TIER_*`. Defaults to Stable when omitted.
  riskTier?: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.quoteMint, isSigner: false, isWritable: false },
    ],
    data: encodeInitMarket(
      args.marketGroupId,
      args.assetSlotCapacity,
      args.vaultBump,
      args.baseMint.toBytes(),
      args.oracleKind,
      args.oracleFeedId,
      args.oraclePool.toBytes(),
      args.riskTier ?? RISK_TIER_STABLE,
    ),
  });
}

/// Create a devnet mock constant-product pool. The client pre-creates the
/// `pool` account (System CreateAccount, owner = program, size MOCK_POOL_SIZE).
export function createMockPoolIx(args: {
  programId: PublicKey;
  pool: PublicKey;
  authority: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  reserveBase: bigint;
  reserveQuote: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.pool, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.baseMint, isSigner: false, isWritable: false },
      { pubkey: args.quoteMint, isSigner: false, isWritable: false },
    ],
    data: encodeCreateMockPool(args.reserveBase, args.reserveQuote),
  });
}

/// Move a mock pool's price. `baseToQuote` true = sell base (down), false =
/// buy base (up). Any signer.
export function mockSwapIx(args: {
  programId: PublicKey;
  pool: PublicKey;
  signer: PublicKey;
  amountIn: bigint;
  baseToQuote: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.pool, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: false },
    ],
    data: encodeMockSwap(args.amountIn, args.baseToQuote),
  });
}

/// DEVNET-ONLY mock-pool crank: read the pinned mock pool, EWMA-fold its spot
/// into the mark, accrue. A mainnet (production) build excludes this handler and
/// rejects the instruction; the production price paths are `accrueAssetIx`,
/// `crankPythIx`, and `crankDexSpotIx`. Kept only for the devnet price toy.
export function crankOracleIx(args: {
  programId: PublicKey;
  market: PublicKey;
  pool: PublicKey;
  signer: PublicKey;
  assetIndex: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.pool, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: false },
    ],
    data: encodeCrankOracle(args.assetIndex),
  });
}

export function encodeCrankPyth(assetIndex: number): Buffer {
  const data = new Uint8Array(1 + 4);
  data[0] = Tag.CrankPyth;
  writeU32LE(data, 1, assetIndex);
  return Buffer.from(data);
}

/// Permissionless crank for a PYTH market: pull a fresh mark from a Pyth
/// `PriceUpdateV2` account (owned by the receiver program, bound to the market's
/// feed id). `priceUpdate` is the sponsored feed account, for example the devnet
/// SOL/USD account 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE. Any signer.
/** The per-market House portfolio PDA; matches Rust `[HOUSE_SEED, market]`. */
export function housePortfolioPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.toBuffer()],
    programId,
  );
}

export function crankPythIx(args: {
  programId: PublicKey;
  market: PublicKey;
  priceUpdate: PublicKey;
  signer: PublicKey;
  assetIndex: number;
}): TransactionInstruction {
  // House portfolio + cap (read-only) let the crank price skew funding from the
  // House's net position; derived here so callers are unchanged.
  const [housePortfolio] = housePortfolioPda(args.programId, args.market);
  const [houseCap] = houseCapPda(args.programId, args.market);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.priceUpdate, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: housePortfolio, isSigner: false, isWritable: false },
      { pubkey: houseCap, isSigner: false, isWritable: false },
    ],
    data: encodeCrankPyth(args.assetIndex),
  });
}

/** The per-market DEX pool config PDA; matches Rust `[DEXPOOL_SEED, market]`. */
export function dexPoolPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DEXPOOL_SEED, market.toBuffer()],
    programId,
  );
}

export function encodeSetDexPool(
  baseVault: Uint8Array,
  quoteVault: Uint8Array,
  baseDecimals: number,
  minQuoteDepth: bigint,
  bump: number,
): Buffer {
  expect32(baseVault, "baseVault");
  expect32(quoteVault, "quoteVault");
  const data = new Uint8Array(1 + 32 + 32 + 1 + 8 + 1);
  data[0] = Tag.SetDexPool;
  data.set(baseVault, 1);
  data.set(quoteVault, 33);
  data[65] = baseDecimals & 0xff;
  writeU64LE(data, 66, minQuoteDepth);
  data[74] = bump;
  return Buffer.from(data);
}

/// Bind a DEX-priced market's constant-product pool: the two SPL token vaults
/// holding the reserves, the base token decimals, and the minimum quote-side
/// depth (quote atoms). Market-authority-signed; the PDA is created on first use.
export function setDexPoolIx(args: {
  programId: PublicKey;
  /** The PDA from `dexPoolPda(programId, market)`. */
  dexPoolPda: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseDecimals: number;
  minQuoteDepth: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.dexPoolPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetDexPool(
      args.baseVault.toBytes(),
      args.quoteVault.toBytes(),
      args.baseDecimals,
      args.minQuoteDepth,
      args.bump,
    ),
  });
}

export function encodeCrankDexSpot(assetIndex: number, bump: number): Buffer {
  const data = new Uint8Array(1 + 4 + 1);
  data[0] = Tag.CrankDexSpot;
  writeU32LE(data, 1, assetIndex);
  data[5] = bump;
  return Buffer.from(data);
}

/** The per-(market, asset) TWAP-state PDA; matches Rust
 * `[TWAP_SEED, market, asset_index_le]`. */
export function twapPda(
  programId: PublicKey,
  market: PublicKey,
  assetIndex: number,
): [PublicKey, number] {
  const idx = new Uint8Array(4);
  writeU32LE(idx, 0, assetIndex);
  return PublicKey.findProgramAddressSync(
    [TWAP_SEED, market.toBuffer(), idx],
    programId,
  );
}

/// Permissionless crank for a DEX-priced market: read the pinned pool's two SPL
/// vault balances, reject a thin pool, fold the spot into the rolling TWAP, and
/// move the EWMA mark only once a full window has elapsed (off the time-weighted
/// average, so a single-block reserve flash cannot shift it). The TWAP-state PDA
/// is derived from (market, assetIndex) and created by the first crank; the
/// signer pays its rent then and the per-tx fee. Any signer.
export function crankDexSpotIx(args: {
  programId: PublicKey;
  market: PublicKey;
  /** The PDA from `dexPoolPda(programId, market)`. */
  dexPoolPda: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  signer: PublicKey;
  assetIndex: number;
}): TransactionInstruction {
  const [twap, bump] = twapPda(args.programId, args.market, args.assetIndex);
  // House portfolio + cap (read-only) for skew funding; derived so callers are unchanged.
  const [housePortfolio] = housePortfolioPda(args.programId, args.market);
  const [houseCap] = houseCapPda(args.programId, args.market);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.dexPoolPda, isSigner: false, isWritable: false },
      { pubkey: args.baseVault, isSigner: false, isWritable: false },
      { pubkey: args.quoteVault, isSigner: false, isWritable: false },
      { pubkey: twap, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: housePortfolio, isSigner: false, isWritable: false },
      { pubkey: houseCap, isSigner: false, isWritable: false },
    ],
    data: encodeCrankDexSpot(args.assetIndex, bump),
  });
}

/// Max legs per PlaceBatchOrder; the program also rejects a batch larger than the
/// market's max_portfolio_assets.
export const MAX_BATCH_LEGS = 8;

/// One leg of a PlaceBatchOrder. `side` is the user's direction (Long/Short);
/// `sizeQ` is the unsigned base size.
export type BatchLeg = {
  side: Side;
  assetIndex: number;
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
};

export function encodePlaceBatchOrder(legs: BatchLeg[]): Buffer {
  if (legs.length === 0 || legs.length > MAX_BATCH_LEGS) {
    throw new Error(
      `PlaceBatchOrder needs 1..${MAX_BATCH_LEGS} legs, got ${legs.length}`,
    );
  }
  const LEG = 37; // side(1)+assetIndex(4)+sizeQ(16)+execPrice(8)+feeBps(8)
  const data = new Uint8Array(2 + legs.length * LEG);
  data[0] = Tag.PlaceBatchOrder;
  data[1] = legs.length;
  legs.forEach((leg, i) => {
    const o = 2 + i * LEG;
    data[o] = leg.side;
    writeU32LE(data, o + 1, leg.assetIndex);
    writeU128LE(data, o + 5, leg.sizeQ);
    writeU64LE(data, o + 21, leg.execPrice);
    writeU64LE(data, o + 29, leg.feeBps);
  });
  return Buffer.from(data);
}

/// Apply several trade legs (user vs House) in one tx with a single margin check:
/// cheaper and atomic versus N separate PlaceOrders. Each leg sets its own asset,
/// side, size, price, and fee. Signer: the portfolio owner or a session-key
/// delegate (pass the delegate PDA as the optional 5th account).
export function placeBatchOrderIx(args: {
  programId: PublicKey;
  market: PublicKey;
  userPortfolio: PublicKey;
  housePortfolio: PublicKey;
  user: PublicKey;
  delegate?: PublicKey;
  legs: BatchLeg[];
}): TransactionInstruction {
  const keys = [
    { pubkey: args.market, isSigner: false, isWritable: true },
    { pubkey: args.userPortfolio, isSigner: false, isWritable: true },
    { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
    { pubkey: args.user, isSigner: true, isWritable: false },
  ];
  if (args.delegate) {
    keys.push({ pubkey: args.delegate, isSigner: false, isWritable: false });
  }
  // House-cap PDA trails the optional delegate (verified canonical on-chain).
  const [houseCap] = houseCapPda(args.programId, args.market);
  keys.push({ pubkey: houseCap, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: args.programId,
    keys,
    data: encodePlaceBatchOrder(args.legs),
  });
}

/// DEVNET-ONLY: pin a mock pool to asset slot `assetIndex` (permissionless,
/// pin-once) for `crankOracleIx`. A mainnet (production) build excludes this
/// handler and rejects the instruction.
export function pinOraclePoolIx(args: {
  programId: PublicKey;
  market: PublicKey;
  pool: PublicKey;
  signer: PublicKey;
  assetIndex: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.pool, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: false },
    ],
    data: encodePinOraclePool(args.assetIndex),
  });
}

/// Convert an account's released positive PnL into withdrawable `capital`.
/// Permissionless: any signer may crank it, and it only credits the user's own
/// profit into the user's own portfolio. Backed by the engine's source-credit,
/// so no House account is needed (upstream Percolator replaced the old
/// House-debit settle with the single-account `convert_released_pnl_to_capital`).
export function settlePnlIx(args: {
  programId: PublicKey;
  market: PublicKey;
  userPortfolio: PublicKey;
  signer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.userPortfolio, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: false },
    ],
    data: encodeSettlePnl(),
  });
}

/** The deterministic portfolio PDA for `(owner, market)`, matches Rust
 *  `[PORTFOLIO_SEED, owner, market]`. One account per wallet per market group;
 *  derivable on any device, no stored keypair. */
export function portfolioPda(
  programId: PublicKey,
  owner: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PORTFOLIO_SEED, owner.toBuffer(), market.toBuffer()],
    programId,
  );
}

export function initPortfolioIx(args: {
  programId: PublicKey;
  /** The portfolio PDA from `portfolioPda(programId, owner, market)`. */
  portfolio: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  /** Canonical bump from `portfolioPda`. */
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.portfolio, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      // owner pays rent for the PDA the program creates → must be writable.
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitPortfolio(args.bump),
  });
}

export function tradeIx(args: {
  programId: PublicKey;
  market: PublicKey;
  longPortfolio: PublicKey;
  shortPortfolio: PublicKey;
  authority: PublicKey;
  assetIndex: number;
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.longPortfolio, isSigner: false, isWritable: true },
      { pubkey: args.shortPortfolio, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeTrade(args.assetIndex, args.sizeQ, args.execPrice, args.feeBps),
  });
}

export function accrueAssetIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  assetIndex: number;
  effectivePrice: bigint;
  fundingRateE9: bigint;
  /** Optional per-market oracle authority PDA from `oracleAuthorityPda`. Pass it
   *  for a market that set a custom oracle authority via `setOracleAuthorityIx`;
   *  omit it for markets that stay on the relayer constant. */
  oracleAuthority?: PublicKey;
}): TransactionInstruction {
  const keys = [
    { pubkey: args.market, isSigner: false, isWritable: true },
    { pubkey: args.authority, isSigner: true, isWritable: false },
    ...(args.oracleAuthority
      ? [{ pubkey: args.oracleAuthority, isSigner: false, isWritable: false }]
      : []),
  ];
  return new TransactionInstruction({
    programId: args.programId,
    keys,
    data: encodeAccrueAsset(
      args.assetIndex,
      args.effectivePrice,
      args.fundingRateE9,
    ),
  });
}

export function activateMarketIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  assetIndex: number;
  authenticatedPrice: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeActivateMarket(args.assetIndex, args.authenticatedPrice),
  });
}

export function depositIx(args: {
  programId: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  userToken: PublicKey;
  vaultToken: PublicKey;
  amount: bigint;
  /// Optional deposit-cap PDA (from `depositCapPda`). Pass it on a DEX-priced
  /// market that raised its cap via `setDepositCapIx` to deposit above the
  /// default floor; omit it to use the floor.
  depositCap?: PublicKey;
}): TransactionInstruction {
  const keys = [
    { pubkey: args.market, isSigner: false, isWritable: true },
    { pubkey: args.portfolio, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    { pubkey: args.userToken, isSigner: false, isWritable: true },
    { pubkey: args.vaultToken, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...(args.depositCap
      ? [{ pubkey: args.depositCap, isSigner: false, isWritable: false }]
      : []),
  ];
  return new TransactionInstruction({
    programId: args.programId,
    keys,
    data: encodeDeposit(args.amount),
  });
}

export function resolveMarketIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeResolveMarket(),
  });
}

export function crankRefreshIx(args: {
  programId: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  cranker: PublicKey;
  assetIndex: number;
  effectivePrice: bigint;
  fundingRateE9: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: true },
      { pubkey: args.cranker, isSigner: true, isWritable: false },
    ],
    data: encodeCrankRefresh(
      args.assetIndex,
      args.effectivePrice,
      args.fundingRateE9,
    ),
  });
}

export function liquidateIx(args: {
  programId: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  liquidator: PublicKey;
  assetIndex: number;
  closeQ: bigint;
  feeBps: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: true },
      { pubkey: args.liquidator, isSigner: true, isWritable: false },
    ],
    data: encodeLiquidate(args.assetIndex, args.closeQ, args.feeBps),
  });
}

export function withdrawIx(args: {
  programId: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  vaultToken: PublicKey;
  userToken: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: args.userToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeWithdraw(args.amount),
  });
}

export function createVaultIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  quoteMint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeCreateVault(),
  });
}

// ---------- House Vault encoders ----------

export function encodeCreateHouseVault(houseBump: number): Buffer {
  if (houseBump < 0 || houseBump > 255) {
    throw new Error(`houseBump out of range: ${houseBump}`);
  }
  return Buffer.from([Tag.CreateHouseVault, houseBump]);
}

export function encodeFundHouseVault(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.FundHouseVault;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

export function encodeWithdrawHouseVault(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.WithdrawHouseVault;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

export function encodePlaceOrder(
  side: Side,
  assetIndex: number,
  sizeQ: bigint,
  execPrice: bigint,
  feeBps: bigint,
): Buffer {
  const data = new Uint8Array(1 + 1 + 4 + 16 + 8 + 8);
  data[0] = Tag.PlaceOrder;
  data[1] = side;
  writeU32LE(data, 2, assetIndex);
  writeU128LE(data, 6, sizeQ);
  writeU64LE(data, 22, execPrice);
  writeU64LE(data, 30, feeBps);
  return Buffer.from(data);
}

// ---------- House Vault TransactionInstruction builders ----------

export function createHouseVaultIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  housePortfolio: PublicKey;
  houseBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeCreateHouseVault(args.houseBump),
  });
}

export function fundHouseVaultIx(args: {
  programId: PublicKey;
  market: PublicKey;
  housePortfolio: PublicKey;
  authority: PublicKey;
  authorityToken: PublicKey;
  vaultToken: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.authorityToken, isSigner: false, isWritable: true },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeFundHouseVault(args.amount),
  });
}

export function withdrawHouseVaultIx(args: {
  programId: PublicKey;
  market: PublicKey;
  housePortfolio: PublicKey;
  authority: PublicKey;
  vaultToken: PublicKey;
  authorityToken: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  // The canonical HLP config PDA is always passed (account 6); the program
  // verifies its address and refuses the withdraw while LP shares are
  // outstanding, so the House cannot be drained out from under HLP depositors.
  // It need not exist on-chain (a market without HLP) - the address is enough.
  const [hlpConfig] = hlpConfigPda(args.programId, args.market);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: args.authorityToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: hlpConfig, isSigner: false, isWritable: false },
    ],
    data: encodeWithdrawHouseVault(args.amount),
  });
}

export function placeOrderIx(args: {
  programId: PublicKey;
  market: PublicKey;
  userPortfolio: PublicKey;
  housePortfolio: PublicKey;
  /// Signer: the portfolio owner, or a registered session-key delegate.
  user: PublicKey;
  /// When the signer is a delegate (session key), pass the delegate PDA as
  /// the optional 5th account so the program can authorize it.
  delegate?: PublicKey;
  side: Side;
  assetIndex: number;
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
}): TransactionInstruction {
  const keys = [
    { pubkey: args.market, isSigner: false, isWritable: true },
    { pubkey: args.userPortfolio, isSigner: false, isWritable: true },
    { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
    { pubkey: args.user, isSigner: true, isWritable: false },
  ];
  if (args.delegate) {
    keys.push({ pubkey: args.delegate, isSigner: false, isWritable: false });
  }
  // The House-cap PDA trails the optional delegate; the program verifies it is
  // the canonical address, so it is always passed (uninitialized = no cap).
  const [houseCap] = houseCapPda(args.programId, args.market);
  keys.push({ pubkey: houseCap, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: args.programId,
    keys,
    data: encodePlaceOrder(
      args.side,
      args.assetIndex,
      args.sizeQ,
      args.execPrice,
      args.feeBps,
    ),
  });
}

export function encodeSetDelegate(
  delegate: Uint8Array,
  bump: number,
  expirySlot: bigint,
): Buffer {
  expect32(delegate, "delegate");
  const data = new Uint8Array(1 + 32 + 1 + 8);
  data[0] = Tag.SetDelegate;
  data.set(delegate, 1);
  data[33] = bump;
  // Slot after which PlaceOrder rejects the delegate (little-endian u64).
  new DataView(data.buffer).setBigUint64(34, expirySlot, true);
  return Buffer.from(data);
}

/// Authorize (or revoke, with the all-zero pubkey) a trading delegate for a
/// portfolio. Owner-signed; one-time wallet tx.
export function setDelegateIx(args: {
  programId: PublicKey;
  delegatePda: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
  bump: number;
  /// Slot after which the delegate is rejected by PlaceOrder. Pass a future
  /// slot (current slot + a bounded TTL); the all-zero delegate (revoke) can
  /// use 0.
  expirySlot: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.delegatePda, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetDelegate(
      args.delegate.toBytes(),
      args.bump,
      args.expirySlot,
    ),
  });
}

/** The per-market oracle authority PDA; matches Rust `[ORACLE_SEED, market]`. */
export function oracleAuthorityPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, market.toBuffer()],
    programId,
  );
}

export function encodeSetOracleAuthority(
  authority: Uint8Array,
  bump: number,
): Buffer {
  expect32(authority, "authority");
  const data = new Uint8Array(1 + 32 + 1);
  data[0] = Tag.SetOracleAuthority;
  data.set(authority, 1);
  data[33] = bump;
  return Buffer.from(data);
}

/// Set or rotate a market's oracle authority (the key allowed to move the mark
/// via AccrueAsset). Market-authority-signed; the all-zero pubkey revokes back
/// to the program constant. The PDA is created on first use.
export function setOracleAuthorityIx(args: {
  programId: PublicKey;
  /** The PDA from `oracleAuthorityPda(programId, market)`. */
  oracleAuthorityPda: PublicKey;
  market: PublicKey;
  /** The market authority (signer; pays PDA rent on first set). */
  authority: PublicKey;
  /** The new oracle authority key (all-zero to revoke to the constant). */
  newAuthority: PublicKey;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.oracleAuthorityPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetOracleAuthority(args.newAuthority.toBytes(), args.bump),
  });
}

/** The per-market deposit-cap PDA; matches Rust `[DEPOSIT_CAP_SEED, market]`. */
export function depositCapPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DEPOSIT_CAP_SEED, market.toBuffer()],
    programId,
  );
}

export function encodeSetDepositCap(maxCapital: bigint, bump: number): Buffer {
  const data = new Uint8Array(1 + 16 + 1);
  data[0] = Tag.SetDepositCap;
  writeU128LE(data, 1, maxCapital);
  data[17] = bump;
  return Buffer.from(data);
}

/// Set a DEX-priced market's per-portfolio deposit cap. Market-authority-signed.
/// `maxCapital` only raises the cap above the program floor; the floor is always
/// enforced. The PDA is created on first use.
export function setDepositCapIx(args: {
  programId: PublicKey;
  /** The PDA from `depositCapPda(programId, market)`. */
  depositCapPda: PublicKey;
  market: PublicKey;
  /** The market authority (signer; pays PDA rent on first set). */
  authority: PublicKey;
  /** Per-portfolio collateral cap in quote atoms (only raises above the floor). */
  maxCapital: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositCapPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetDepositCap(args.maxCapital, args.bump),
  });
}

/** The per-market House-cap PDA; matches Rust `[HOUSE_CAP_SEED, market]`. */
export function houseCapPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HOUSE_CAP_SEED, market.toBuffer()],
    programId,
  );
}

export function encodeSetHouseCap(maxBasePosition: bigint, bump: number): Buffer {
  const data = new Uint8Array(1 + 16 + 1);
  data[0] = Tag.SetHouseCap;
  writeU128LE(data, 1, maxBasePosition);
  data[17] = bump;
  return Buffer.from(data);
}

/// Set a market's House exposure cap: the max net House position per asset (base
/// units). Market-authority-signed; a zero cap disables it. The PDA is created on
/// first use. PlaceOrder / PlaceBatchOrder verify this PDA's canonical address, so
/// the cap cannot be bypassed by omitting the trailing account.
export function setHouseCapIx(args: {
  programId: PublicKey;
  /** The PDA from `houseCapPda(programId, market)`. */
  houseCapPda: PublicKey;
  market: PublicKey;
  /** The market authority (signer; pays PDA rent on first set). */
  authority: PublicKey;
  /** Max net House position per asset in base units (0 disables the cap). */
  maxBasePosition: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.houseCapPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetHouseCap(args.maxBasePosition, args.bump),
  });
}

export function encodeSetRequireVerifiable(required: boolean): Buffer {
  const data = new Uint8Array(1 + 1);
  data[0] = Tag.SetRequireVerifiable;
  data[1] = required ? 1 : 0;
  return Buffer.from(data);
}

/// Set a market's require-verifiable flag. Market-authority-signed. When enabled,
/// AccrueAsset can no longer move the mark (the authority-set price is forced to a
/// delta-0 accrual); only CrankPyth / CrankDexSpot price the market. The flag
/// lives in the market header, so there is no extra account.
export function setRequireVerifiableIx(args: {
  programId: PublicKey;
  market: PublicKey;
  /** The market authority (signer). */
  authority: PublicKey;
  required: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeSetRequireVerifiable(args.required),
  });
}

// ---------- Insurance fund (Phase 1a, engine-integrated) ----------
//
// Insurance capital lives in the engine's own per-(asset, side) domain insurance
// ledger inside the market vault: funding raises the engine's total insurance `I`
// and the domain budget; the engine's liquidation waterfall consumes it
// automatically. There is no separate vault. `side` is 0 = Long, 1 = Short (the
// `Side` enum). This config PDA holds only the withdrawal governance.

/** The per-market insurance config PDA (floor + timelock + pending); matches Rust
 * `[INSURANCE_CFG_SEED, market]`. */
export function insuranceCfgPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INSURANCE_CFG_SEED, market.toBuffer()],
    programId,
  );
}

export function encodeFundInsurance(
  assetIndex: number,
  side: number,
  amount: bigint,
): Buffer {
  const data = new Uint8Array(1 + 4 + 1 + 16);
  data[0] = Tag.FundInsurance;
  writeU32LE(data, 1, assetIndex);
  data[5] = side;
  writeU128LE(data, 6, amount);
  return Buffer.from(data);
}

/// Fund the engine's per-(asset, side) domain insurance. Permissionless: any signer
/// may transfer quote tokens into the backstop from their own token account, raising
/// the engine's total insurance `I` and the domain budget. `vaultToken` is the market
/// vault (`wrapper.vault`).
export function fundInsuranceIx(args: {
  programId: PublicKey;
  market: PublicKey;
  funder: PublicKey;
  funderToken: PublicKey;
  vaultToken: PublicKey;
  assetIndex: number;
  /** 0 = Long, 1 = Short (the `Side` enum). */
  side: number;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.funder, isSigner: true, isWritable: false },
      { pubkey: args.funderToken, isSigner: false, isWritable: true },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeFundInsurance(args.assetIndex, args.side, args.amount),
  });
}

export function encodeSetInsuranceParams(
  minBalance: bigint,
  withdrawDelaySlots: bigint,
  bump: number,
): Buffer {
  const data = new Uint8Array(1 + 16 + 8 + 1);
  data[0] = Tag.SetInsuranceParams;
  writeU128LE(data, 1, minBalance);
  writeU64LE(data, 17, withdrawDelaySlots);
  data[25] = bump;
  return Buffer.from(data);
}

/// Set (and ratchet) the insurance fund's withdrawal floor and timelock.
/// Market-authority-signed; the config PDA is created on first use. Both `minBalance`
/// and `withdrawDelaySlots` are RAISE-ONLY. `cfgPda` is `insuranceCfgPda(...)`.
export function setInsuranceParamsIx(args: {
  programId: PublicKey;
  /** The PDA from `insuranceCfgPda(programId, market)`. */
  cfgPda: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  /** The withdrawal floor in quote atoms (a withdrawal can never breach it). */
  minBalance: bigint;
  /** Slots a withdrawal is announced ahead via the request/execute timelock. */
  withdrawDelaySlots: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetInsuranceParams(
      args.minBalance,
      args.withdrawDelaySlots,
      args.bump,
    ),
  });
}

export function encodeRequestInsuranceWithdraw(
  assetIndex: number,
  side: number,
  amount: bigint,
  bump: number,
): Buffer {
  const data = new Uint8Array(1 + 4 + 1 + 16 + 1);
  data[0] = Tag.RequestInsuranceWithdraw;
  writeU32LE(data, 1, assetIndex);
  data[5] = side;
  writeU128LE(data, 6, amount);
  data[22] = bump;
  return Buffer.from(data);
}

/// Request an insurance withdrawal from an (asset, side) domain: records a pending
/// (amount, unlock = now + delay, domain) after checking the amount leaves the floor
/// on the engine's total insurance `I` intact. Market-authority-signed; no funds
/// move. `bump` is the config PDA bump.
export function requestInsuranceWithdrawIx(args: {
  programId: PublicKey;
  /** The PDA from `insuranceCfgPda(programId, market)`. */
  cfgPda: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  assetIndex: number;
  /** 0 = Long, 1 = Short (the `Side` enum). */
  side: number;
  amount: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeRequestInsuranceWithdraw(
      args.assetIndex,
      args.side,
      args.amount,
      args.bump,
    ),
  });
}

export function encodeExecuteInsuranceWithdraw(bump: number): Buffer {
  return Buffer.from([Tag.ExecuteInsuranceWithdraw, bump]);
}

/// Execute a previously requested insurance withdrawal once its timelock has
/// elapsed. Re-checks the floor against the live engine insurance `I`, calls the
/// engine's verified domain-insurance withdraw, transfers the tokens out signed by
/// the market vault PDA, and clears the pending slot. Market-authority-signed.
/// `vaultToken` is the market vault (`wrapper.vault`); `bump` is the config PDA bump.
export function executeInsuranceWithdrawIx(args: {
  programId: PublicKey;
  /** The PDA from `insuranceCfgPda(programId, market)`. */
  cfgPda: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  vaultToken: PublicKey;
  authorityToken: PublicKey;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: args.authorityToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeExecuteInsuranceWithdraw(args.bump),
  });
}

// ---------- House LP (HLP), Phase 2a deposit path ----------

/** The per-market HLP config PDA; matches Rust `[HLP_SEED, market]`. */
export function hlpConfigPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([HLP_SEED, market.toBuffer()], programId);
}

/** The per-market HLP free-buffer vault PDA; matches Rust `[HLP_VAULT_SEED, market]`. */
export function hlpVaultPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HLP_VAULT_SEED, market.toBuffer()],
    programId,
  );
}

/** The per-LP HLP position PDA; matches Rust `[HLP_POSITION_SEED, market, owner]`. */
export function hlpPositionPda(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HLP_POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    programId,
  );
}

export function encodeCreateHlpVault(): Buffer {
  return Buffer.from([Tag.CreateHlpVault]);
}

/// Create the per-market HLP free-buffer vault (an SPL token account at
/// `[HLP_VAULT_SEED, market]`). Market-authority-signed, one-time. `vault` is
/// `hlpVaultPda(programId, market)[0]`.
export function createHlpVaultIx(args: {
  programId: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  quoteMint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeCreateHlpVault(),
  });
}

export function encodeSetHlpParams(
  redeemDelaySlots: bigint,
  feeBps: bigint,
  minDeposit: bigint,
  navHaircutBps: bigint,
  bump: number,
): Buffer {
  const data = new Uint8Array(1 + 8 + 8 + 16 + 8 + 1);
  data[0] = Tag.SetHlpParams;
  writeU64LE(data, 1, redeemDelaySlots);
  writeU64LE(data, 9, feeBps);
  writeU128LE(data, 17, minDeposit);
  writeU64LE(data, 33, navHaircutBps);
  data[41] = bump;
  return Buffer.from(data);
}

/// Set the HLP config (redeem timelock, deposit/redeem fee, min deposit, and the
/// NAV haircut on the House's positive marked PnL). Market-authority-signed; the
/// config PDA is created on first use. `cfgPda` is `hlpConfigPda(...)`.
export function setHlpParamsIx(args: {
  programId: PublicKey;
  cfgPda: PublicKey;
  market: PublicKey;
  authority: PublicKey;
  redeemDelaySlots: bigint;
  feeBps: bigint;
  minDeposit: bigint;
  /// Haircut (bps) on the House's positive marked PnL in NAV (0 = raw equity). */
  navHaircutBps: bigint;
  bump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetHlpParams(
      args.redeemDelaySlots,
      args.feeBps,
      args.minDeposit,
      args.navHaircutBps,
      args.bump,
    ),
  });
}

export function encodeDepositHlp(amount: bigint, positionBump: number): Buffer {
  const data = new Uint8Array(1 + 16 + 1);
  data[0] = Tag.DepositHlp;
  writeU128LE(data, 1, amount);
  data[17] = positionBump;
  return Buffer.from(data);
}

/// Deposit quote tokens into the HLP buffer and mint LP shares priced at the
/// pre-deposit NAV (buffer balance + the House's marked equity). Permissionless.
/// `position` is `hlpPositionPda(programId, market, depositor)`, `vault` is
/// `hlpVaultPda(...)`, `housePortfolio` is the `[HOUSE_SEED, market]` PDA.
export function depositHlpIx(args: {
  programId: PublicKey;
  cfgPda: PublicKey;
  market: PublicKey;
  depositor: PublicKey;
  depositorToken: PublicKey;
  vault: PublicKey;
  position: PublicKey;
  housePortfolio: PublicKey;
  amount: bigint;
  positionBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.depositorToken, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeDepositHlp(args.amount, args.positionBump),
  });
}

// ---------- House LP (HLP), Phase 2a deploy + redeem path ----------

export function encodeDeployHlp(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.DeployHlp;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

/// Deploy quote tokens from the HLP buffer into the engine House (the FundHouseVault
/// path). Market-authority-signed. `vault` is the HLP buffer (`hlpVaultPda`),
/// `marketVault` is `wrapper.vault`, `housePortfolio` the `[HOUSE_SEED, market]` PDA.
export function deployHlpIx(args: {
  programId: PublicKey;
  market: PublicKey;
  housePortfolio: PublicKey;
  vault: PublicKey;
  marketVault: PublicKey;
  authority: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.marketVault, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeDeployHlp(args.amount),
  });
}

export function encodeRequestRedeemHlp(
  shares: bigint,
  positionBump: number,
): Buffer {
  const data = new Uint8Array(1 + 16 + 1);
  data[0] = Tag.RequestRedeemHlp;
  writeU128LE(data, 1, shares);
  data[17] = positionBump;
  return Buffer.from(data);
}

/// Request redemption of `shares`: records a pending (shares, unlock = now + delay)
/// on the LP's position. No funds move; pricing is at execute time. `position` is
/// `hlpPositionPda(programId, market, owner)`.
export function requestRedeemHlpIx(args: {
  programId: PublicKey;
  cfgPda: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  position: PublicKey;
  shares: bigint;
  positionBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: false },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.position, isSigner: false, isWritable: true },
    ],
    data: encodeRequestRedeemHlp(args.shares, args.positionBump),
  });
}

export function encodeExecuteRedeemHlp(positionBump: number): Buffer {
  return Buffer.from([Tag.ExecuteRedeemHlp, positionBump]);
}

/// Execute a requested redemption once its timelock elapses: prices the pending
/// shares at the live NAV, pays out from the buffer (bounded by the free buffer),
/// burns the shares. Market-authority not required (the LP owner signs). `vault` is
/// the HLP buffer, `housePortfolio` the `[HOUSE_SEED, market]` PDA.
export function executeRedeemHlpIx(args: {
  programId: PublicKey;
  cfgPda: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  ownerToken: PublicKey;
  vault: PublicKey;
  position: PublicKey;
  housePortfolio: PublicKey;
  positionBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.cfgPda, isSigner: false, isWritable: true },
      { pubkey: args.market, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.ownerToken, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeExecuteRedeemHlp(args.positionBump),
  });
}

// ---------- House LP (HLP), Phase 2b harvest ----------

export function encodeHarvestHlp(amount: bigint): Buffer {
  const data = new Uint8Array(1 + 16);
  data[0] = Tag.HarvestHlp;
  writeU128LE(data, 1, amount);
  return Buffer.from(data);
}

/// Harvest House capital back into the HLP buffer (refills redemption liquidity).
/// Withdraws from the engine House into the buffer; the engine refuses while the
/// House is positioned, so this only lands in flat windows. Market-authority-signed.
/// `marketVault` is `wrapper.vault`, `vault` the HLP buffer, `housePortfolio` the
/// `[HOUSE_SEED, market]` PDA.
export function harvestHlpIx(args: {
  programId: PublicKey;
  market: PublicKey;
  housePortfolio: PublicKey;
  marketVault: PublicKey;
  vault: PublicKey;
  authority: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: args.marketVault, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeHarvestHlp(args.amount),
  });
}
