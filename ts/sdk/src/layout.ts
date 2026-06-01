// Byte sizes and field offsets of the OpenPerps wrapper + engine zero-copy
// account structs. Mirror Rust at commit head — verified via
//   cargo test -p openperps-program print_byte_sizes_for_sdk -- --nocapture
// If you bump the engine or the OpenPerpsMarketHeader, re-run that test and
// update here.

// OpenPerps wrapper header (prefix of every market account). v4 layout.
export const WRAPPER_HEADER_SIZE = 208;
// Offsets within OpenPerpsMarketHeader.
export const OFFSET_WRAPPER_DISCRIMINATOR = 0;
export const OFFSET_WRAPPER_VERSION = 8;
export const OFFSET_WRAPPER_VAULT_BUMP = 12;
export const OFFSET_WRAPPER_HOUSE_BUMP = 13;
export const OFFSET_WRAPPER_ORACLE_KIND = 14;
export const OFFSET_WRAPPER_AUTHORITY = 16; // [u8; 32]
export const OFFSET_WRAPPER_QUOTE_MINT = 48; // [u8; 32]
export const OFFSET_WRAPPER_VAULT = 80; // [u8; 32]
export const OFFSET_WRAPPER_BASE_MINT = 112; // [u8; 32]
export const OFFSET_WRAPPER_ORACLE_FEED_ID = 144; // [u8; 32]
export const OFFSET_WRAPPER_ORACLE_POOL = 176; // [u8; 32]

/** oracle_kind discriminants — mirror Rust `state::oracle_kind`. */
export const ORACLE_KIND_MANUAL = 0;
export const ORACLE_KIND_PYTH = 1;
export const ORACLE_KIND_DEX_EWMA = 2;

/** Mock-pool account size + price scale — mirror Rust `state`. */
export const MOCK_POOL_SIZE = 120;
export const PRICE_SCALE = 1_000_000n;

// Engine structs (after the wrapper prefix in a market account).
export const MARKET_HEADER_SIZE = 638;
// Market<[u8;32]> = 32-byte per-slot wrapper (the pinned oracle pool) + the
// 1285-byte engine slot. The wrapper sits at the START of each slot.
export const MARKET_SLOT_WRAPPER_SIZE = 32;
export const MARKET_SLOT_SIZE = 1317;
export const PORTFOLIO_HEADER_SIZE = 2907;
export const SOURCE_DOMAIN_SIZE = 160;

// Engine-relative offsets (within MarketGroupV16HeaderAccount).
const ENGINE_OFFSET_VAULT = 285;
const ENGINE_OFFSET_C_TOT = 317;

// Absolute offsets into a market account's data buffer (= wrapper prefix +
// engine-relative offset). These are what SDK consumers read.
export const OFFSET_VAULT = WRAPPER_HEADER_SIZE + ENGINE_OFFSET_VAULT;
export const OFFSET_C_TOT = WRAPPER_HEADER_SIZE + ENGINE_OFFSET_C_TOT;

// `effective_price` within an engine slot, AFTER the 32-byte slot wrapper:
// in-slot offset 57 (V16PodU64, [u8;8] LE). Verified via the byte-sizes test.
const SLOT_EFFECTIVE_PRICE_IN_SLOT = 57;

/// Absolute byte offset of asset slot `i`'s start (its wrapper / pinned pool).
export function slotOffset(i: number): number {
  return WRAPPER_HEADER_SIZE + MARKET_HEADER_SIZE + i * MARKET_SLOT_SIZE;
}

/// Absolute byte offset of asset slot `i`'s EWMA mark (effective_price).
export function slotEffectivePriceOffset(i: number): number {
  return slotOffset(i) + SLOT_EFFECTIVE_PRICE_IN_SLOT;
}

/// Slot 0 mark, kept for back-compat with single-slot readers.
export const OFFSET_SLOT0_EFFECTIVE_PRICE = slotEffectivePriceOffset(0);

// Portfolio account has no wrapper prefix — offsets are direct.
export const OFFSET_CAPITAL = 132; // V16PodU128 ([u8; 16])
export const OFFSET_PNL = 148; // V16PodI128 ([u8; 16])

// Portfolio legs (open positions). Verified via the byte-sizes test.
export const OFFSET_PORTFOLIO_LEGS = 228;
export const PORTFOLIO_LEG_SIZE = 144;
export const PORTFOLIO_LEG_COUNT = 16;
// Within a leg: active(u8)@0, asset_index(u32)@1, side(u8)@13, basis_pos_q(i128)@14.
const LEG_ACTIVE = 0;
const LEG_ASSET_INDEX = 1;
const LEG_SIDE = 13;
const LEG_BASIS_POS_Q = 14;

export type DecodedPosition = {
  assetIndex: number;
  /// 0 = Long, 1 = Short (mirrors `Side`).
  side: number;
  /// Net position size in q units (POS_SCALE = 1e6), always positive.
  sizeQ: bigint;
};

/// Decode a portfolio account's active legs into open positions. Only the
/// unambiguous fields are read (active, asset_index, side, |basis_pos_q|);
/// entry / liq / per-leg PnL involve engine accounting scale and are left to
/// the (future) indexer.
export function decodePortfolioPositions(data: Uint8Array): DecodedPosition[] {
  const out: DecodedPosition[] = [];
  for (let i = 0; i < PORTFOLIO_LEG_COUNT; i++) {
    const base = OFFSET_PORTFOLIO_LEGS + i * PORTFOLIO_LEG_SIZE;
    if (base + PORTFOLIO_LEG_SIZE > data.length) break;
    if (data[base + LEG_ACTIVE] !== 1) continue;
    const assetIndex =
      data[base + LEG_ASSET_INDEX]! |
      (data[base + LEG_ASSET_INDEX + 1]! << 8) |
      (data[base + LEG_ASSET_INDEX + 2]! << 16) |
      (data[base + LEG_ASSET_INDEX + 3]! << 24);
    const side = data[base + LEG_SIDE]!;
    const basis = readI128LE(data, base + LEG_BASIS_POS_Q);
    const sizeQ = basis < 0n ? -basis : basis;
    if (sizeQ === 0n) continue;
    out.push({ assetIndex, side, sizeQ });
  }
  return out;
}

export function marketAccountSize(assetSlotCapacity: number): number {
  return WRAPPER_HEADER_SIZE + MARKET_HEADER_SIZE + assetSlotCapacity * MARKET_SLOT_SIZE;
}

export function portfolioAccountSize(assetSlotCapacity: number): number {
  // Two source domains (long, short) per asset slot.
  return PORTFOLIO_HEADER_SIZE + assetSlotCapacity * 2 * SOURCE_DOMAIN_SIZE;
}

/** Vault PDA seed prefix — matches Rust `state::VAULT_SEED`. */
export const VAULT_SEED = Buffer.from("vault");

/** House Vault PDA seed prefix — matches Rust `state::HOUSE_SEED`. */
export const HOUSE_SEED = Buffer.from("house");

/** Trading-delegate PDA seed prefix — matches Rust `state::DELEGATE_SEED`. */
export const DELEGATE_SEED = Buffer.from("delegate");

/** User-portfolio PDA seed prefix — matches Rust `state::PORTFOLIO_SEED`. */
export const PORTFOLIO_SEED = Buffer.from("portfolio");

/** DelegateAccount size: discriminator(8) + portfolio(32) + delegate(32). */
export const DELEGATE_ACCOUNT_SIZE = 72;

// MockPoolHeader offsets: discriminator(8) + base_mint(32) + quote_mint(32)
// + reserve_base(8) + reserve_quote(8) + authority(32).
export const OFFSET_POOL_RESERVE_BASE = 72;
export const OFFSET_POOL_RESERVE_QUOTE = 80;

/** Read a little-endian u64 from a byte buffer at `offset`. */
export function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(data[offset + i]!);
  }
  return v;
}

/** Spot price (quote atoms per 1.0 base, ×PRICE_SCALE) from pool reserves. */
export function poolSpotPrice(data: Uint8Array): bigint {
  const rb = readU64LE(data, OFFSET_POOL_RESERVE_BASE);
  const rq = readU64LE(data, OFFSET_POOL_RESERVE_QUOTE);
  if (rb === 0n) return 0n;
  return (rq * PRICE_SCALE) / rb;
}

/** Read a little-endian u128 from a byte buffer at `offset`. */
export function readU128LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) {
    v = (v << 8n) | BigInt(data[offset + i]!);
  }
  return v;
}

/** Read a little-endian i128 from a byte buffer at `offset` (two's complement). */
export function readI128LE(data: Uint8Array, offset: number): bigint {
  const u = readU128LE(data, offset);
  const TOP = 1n << 127n;
  return u & TOP ? u - (1n << 128n) : u;
}
