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

import {PublicKey, SystemProgram, type TransactionInstruction} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
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

export interface TokenLaunchInput {
  programId: PublicKey;
  /// The creator: pays rent, is the mint + market authority, and seeds the House.
  authority: PublicKey;
  /// A fresh keypair public key for the new SPL mint (the caller signs mint creation
  /// with it). This becomes the perp's coin-margin collateral token.
  mint: PublicKey;
  /// Rent for the mint account, from `getMinimumBalanceForRentExemption(MINT_SIZE)`.
  mintRentLamports: number;
  /// Mint decimals (commonly 6 or 9).
  decimals: number;
  /// Total supply minted to the creator, in token atoms. Must be >= allocationAtoms.
  totalSupply: bigint;
  /// Revoke the mint authority after minting (fixed supply, a launch trust signal).
  /// Default false. The freeze authority is never set (no freeze on launch tokens).
  revokeMintAuthority?: boolean;
  /// A fresh keypair public key for the market account (the caller signs with it).
  market: PublicKey;
  /// Rent for the market account, from
  /// `getMinimumBalanceForRentExemption(marketAccountSize(capacity))`.
  marketRentLamports: number;
  /// The slice of the supply that seeds the perp House (productive, not locked), in
  /// token atoms. Must be <= totalSupply.
  allocationAtoms: bigint;
  /// Launch price in USD (the MANUAL mark is seeded here).
  launchPriceUsd: number;
  priceDecimals?: number;
  symbol: string;
  name?: string;
  /// Relayer/keeper key allowed to move the MANUAL mark. Defaults to `authority`.
  oracleAuthority?: PublicKey;
  houseCapBase?: bigint;
  depositCapAtoms?: bigint;
  /// Optional token metadata instruction (e.g. a Metaplex CreateMetadataAccountV3 the
  /// caller built for [`metadata`, mpl_program, mint]). Inserted right after the mint is
  /// initialized. Omitted by default: metadata needs the Metaplex program, which is not
  /// present on a bare local validator, so this stays a caller-supplied hook.
  metadataInstruction?: TransactionInstruction;
}

export interface TokenLaunch {
  /// The new mint (== `input.mint`).
  mint: PublicKey;
  /// The market account (== `input.market`).
  market: PublicKey;
  /// The creator's associated token account for the new mint (holds the supply; funds
  /// the House seed).
  creatorTokenAccount: PublicKey;
  /// Mint creation + supply (+ optional metadata). Sign with the MINT keypair (it signs
  /// the mint account creation) and the authority.
  tokenInstructions: TransactionInstruction[];
  /// The perp launch (coin-margin market + House seed). `listing.instructions` must be
  /// signed with the MARKET keypair (it signs the market account creation) and the
  /// authority.
  listing: PerpMarketListing;
}

/// One call to launch a token AND a coin-margin perp on it: mint a fresh SPL token,
/// send the supply to the creator, and stand up a perp seeded by the allocation. Pure
/// (no network, no sending). The returned `tokenInstructions` and `listing.instructions`
/// are ordered; send `tokenInstructions` first (so the creator holds the allocation
/// before the House seed pulls from it), then the launch. See the module comment and
/// `buildLaunchpadPerp` for the perp-side design and its trade-offs.
export function buildTokenLaunchWithPerp(input: TokenLaunchInput): TokenLaunch {
  if (input.allocationAtoms > input.totalSupply) {
    throw new Error("buildTokenLaunchWithPerp: allocationAtoms exceeds totalSupply");
  }
  const creatorTokenAccount = getAssociatedTokenAddressSync(input.mint, input.authority);

  const tokenInstructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: input.authority,
      newAccountPubkey: input.mint,
      lamports: input.mintRentLamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    // No freeze authority: a launch token must not be freezable.
    createInitializeMint2Instruction(input.mint, input.decimals, input.authority, null),
  ];
  if (input.metadataInstruction !== undefined) {
    tokenInstructions.push(input.metadataInstruction);
  }
  tokenInstructions.push(
    createAssociatedTokenAccountInstruction(
      input.authority,
      creatorTokenAccount,
      input.authority,
      input.mint,
    ),
    createMintToInstruction(input.mint, creatorTokenAccount, input.authority, input.totalSupply),
  );
  if (input.revokeMintAuthority) {
    // Fixed supply: drop the mint authority so no more can ever be minted.
    tokenInstructions.push(
      createSetAuthorityInstruction(input.mint, input.authority, AuthorityType.MintTokens, null),
    );
  }

  const launchInput: LaunchpadPerpInput = {
    programId: input.programId,
    authority: input.authority,
    market: input.market,
    marketRentLamports: input.marketRentLamports,
    token: input.mint,
    symbol: input.symbol,
    launchPriceUsd: input.launchPriceUsd,
    allocationAtoms: input.allocationAtoms,
    authorityTokenAccount: creatorTokenAccount,
  };
  if (input.name !== undefined) launchInput.name = input.name;
  if (input.priceDecimals !== undefined) launchInput.priceDecimals = input.priceDecimals;
  if (input.oracleAuthority !== undefined) launchInput.oracleAuthority = input.oracleAuthority;
  if (input.houseCapBase !== undefined) launchInput.houseCapBase = input.houseCapBase;
  if (input.depositCapAtoms !== undefined) launchInput.depositCapAtoms = input.depositCapAtoms;

  return {
    mint: input.mint,
    market: input.market,
    creatorTokenAccount,
    tokenInstructions,
    listing: buildLaunchpadPerp(launchInput),
  };
}
