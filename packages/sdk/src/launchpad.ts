// OPP Launchpad: launch a coin-margin perp on a freshly created token, seeded by the
// creator's allocation instead of locking it.
//
// The idea: when you mint a token you hold a large allocation. Instead of locking it,
// you put it to work as the liquidity of a perp on that same token (coin-margin, where
// the token IS the collateral, the liquidity, and the settlement). The allocation seeds
// the House, earns the House edge, and gives the token an instant leveraged market with
// zero USDC needed.
//
// Everything here reuses existing on-chain instructions; there is no program change.
// `buildLaunchpadPerp` is a thin, opinionated preset over `buildPerpMarketListing`:
//   - quote_mint == base_mint == the token  => coin-margin. The program forces the
//     VOLATILE risk tier (5x, 20% initial margin) and the SDK auto-applies the safe
//     coin-margin risk profile (House OI cap, stale-pause, impact+skew spread).
//   - MANUAL oracle seeded at the launch price (a fresh token has no deep pool yet);
//     a relayer (oracleAuthority) keeps the mark live, and the market graduates to a
//     verifiable DEX-EWMA crank once a pool is deep enough (SetDexPool flips
//     require_verifiable 0 -> 1, a one-way ratchet).
//   - the creator allocation funds the House (productive, not locked). It is a SOFT
//     commitment: the engine refuses a House withdrawal while any position is open, so
//     the seed is committed for as long as the market is active, but it is not a hard
//     timelock (the creator can withdraw once the market is flat). A hard rug-proof
//     lock would need a program-level timelock, which this preset does not add.

import {PublicKey} from "@solana/web3.js";
import {
  buildPerpMarketListing,
  type BuildPerpMarketListingInput,
  type PerpMarketListing,
} from "./perp-listing.ts";

export interface LaunchpadPerpInput {
  programId: PublicKey;
  /// The creator / launchpad operator. Signs creation and seeds the House.
  authority: PublicKey;
  /// A fresh keypair public key for the market account (the caller signs with it).
  market: PublicKey;
  /// Rent for the market account, from
  /// `getMinimumBalanceForRentExemption(marketAccountSize(capacity))`.
  marketRentLamports: number;
  /// The freshly launched token mint. It becomes BOTH base and quote (coin-margin):
  /// collateral, liquidity, PnL, and settlement are all this token.
  token: PublicKey;
  symbol: string;
  name?: string;
  /// Launch price in USD (e.g. the bonding-curve / fair-launch start price). The MANUAL
  /// mark is seeded here; `oracleAuthority` updates it until the market graduates.
  launchPriceUsd: number;
  /// Mark price scale (integer decimals). Default 6.
  priceDecimals?: number;
  /// The creator allocation that seeds the perp House, in TOKEN atoms. Instead of being
  /// locked, it becomes productive liquidity that earns the House edge.
  allocationAtoms: bigint;
  /// The creator's token account (of `token`); funds the House seed.
  authorityTokenAccount: PublicKey;
  /// Relayer/keeper key allowed to move the MANUAL mark. Defaults to `authority`.
  oracleAuthority?: PublicKey;
  /// Optional extra launch caps on top of the coin-margin auto-profile: a static House
  /// net-position ceiling (base units) and a per-wallet deposit ceiling (token atoms).
  /// Recommended small for a fresh, reflexive market; raise as the pool deepens.
  houseCapBase?: bigint;
  depositCapAtoms?: bigint;
}

/// Build every instruction to launch a coin-margin perp on a freshly created token,
/// seeded by the creator allocation. The returned `instructions` are ordered and ready
/// to sign (the market keypair signs the account creation, the authority signs the
/// rest). See the module comment for the design and its trade-offs.
export function buildLaunchpadPerp(input: LaunchpadPerpInput): PerpMarketListing {
  const mint = input.token.toBase58();
  const listing: BuildPerpMarketListingInput = {
    programId: input.programId,
    authority: input.authority,
    market: input.market,
    marketRentLamports: input.marketRentLamports,
    // quote == base == the token: coin-margin. The program forces VOLATILE (5x) and the
    // SDK auto-applies the safe coin-margin risk profile (OI cap, stale-pause, spread).
    baseMint: mint,
    quoteMint: mint,
    symbol: input.symbol,
    // A fresh token has no market data yet; empty signals let the classifier pick the
    // conservative (experimental) posture, which lines up with the on-chain coin-margin
    // forcing. No oraclePool / oracleFeedId is supplied, so the listing stays MANUAL.
    signals: {},
    priceUsd: input.launchPriceUsd,
    // The allocation seeds the House (productive, not locked).
    initialHouseDepositAtoms: input.allocationAtoms.toString(),
    authorityQuoteToken: input.authorityTokenAccount,
    // MANUAL market needs its own relayer key, or the mark stays frozen.
    oracleAuthority: input.oracleAuthority ?? input.authority,
  };
  if (input.name !== undefined) listing.name = input.name;
  if (input.priceDecimals !== undefined) listing.priceDecimals = input.priceDecimals;
  if (input.houseCapBase !== undefined) listing.houseCapBase = input.houseCapBase;
  if (input.depositCapAtoms !== undefined) listing.depositCapAtoms = input.depositCapAtoms;
  return buildPerpMarketListing(listing);
}
