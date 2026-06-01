// Instruction encoders mirroring Rust `crates/program/src/instruction.rs`.
// Wire format: 1-byte tag followed by little-endian payload.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { PORTFOLIO_SEED } from "./layout.ts";

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
} as const;

/// Side encoding for `PlaceOrder`.
export const Side = {
  Long: 0,
  Short: 1,
} as const;
export type Side = (typeof Side)[keyof typeof Side];

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffff_ffff) throw new Error(`u32 out of range: ${value}`);
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value >= 1n << 64n) throw new Error(`u64 out of range: ${value}`);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value >= 1n << 128n) throw new Error(`u128 out of range: ${value}`);
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
  if (value < MIN || value > MAX) throw new Error(`i128 out of range: ${value}`);
  const unsigned = value < 0n ? value + (1n << 128n) : value;
  writeU128LE(buf, offset, unsigned);
}

function expect32(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
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
  // tag(1) + marketGroupId(32) + capacity(4) + vaultBump(1)
  //   + baseMint(32) + oracleKind(1) + oracleFeedId(32) + oraclePool(32)
  const data = new Uint8Array(1 + 32 + 4 + 1 + 32 + 1 + 32 + 32);
  data[0] = Tag.InitMarket;
  data.set(marketGroupId, 1);
  writeU32LE(data, 33, assetSlotCapacity);
  data[37] = vaultBump;
  data.set(baseMint, 38);
  data[70] = oracleKind;
  data.set(oracleFeedId, 71);
  data.set(oraclePool, 103);
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

/// Permissionless DEX-EWMA crank: read the pinned pool, EWMA-fold its spot
/// into the mark, accrue. Any signer.
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

/// Pin a DEX pool to asset slot `assetIndex` (permissionless, pin-once).
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

/** The deterministic portfolio PDA for `(owner, market)` — matches Rust
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
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
    ],
    data: encodeAccrueAsset(args.assetIndex, args.effectivePrice, args.fundingRateE9),
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
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.userToken, isSigner: false, isWritable: true },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
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
    data: encodeCrankRefresh(args.assetIndex, args.effectivePrice, args.fundingRateE9),
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
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.market, isSigner: false, isWritable: true },
      { pubkey: args.housePortfolio, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.vaultToken, isSigner: false, isWritable: true },
      { pubkey: args.authorityToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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

export function encodeSetDelegate(delegate: Uint8Array, bump: number): Buffer {
  expect32(delegate, "delegate");
  const data = new Uint8Array(1 + 32 + 1);
  data[0] = Tag.SetDelegate;
  data.set(delegate, 1);
  data[33] = bump;
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
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.delegatePda, isSigner: false, isWritable: true },
      { pubkey: args.portfolio, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetDelegate(args.delegate.toBytes(), args.bump),
  });
}
