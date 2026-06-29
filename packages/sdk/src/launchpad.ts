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

import {PublicKey, SystemProgram, TransactionInstruction} from "@solana/web3.js";
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
  /// Token name / symbol / image, via Metaplex (`buildTokenMetadataIx`). When set, the
  /// metadata instruction is built and inserted right after the mint is initialized.
  /// Needs the Metaplex program on-chain (devnet / mainnet, NOT a bare local validator).
  metadata?: {
    name: string;
    symbol: string;
    uri?: string;
    sellerFeeBasisPoints?: number;
    isMutable?: boolean;
  };
  /// Lower-level alternative to `metadata`: a pre-built metadata instruction (e.g. from
  /// another Metaplex SDK). Ignored when `metadata` is set.
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
  // Metadata (name / symbol / image) right after the mint is initialized, while the
  // creator is still the mint authority. `metadata` builds it; `metadataInstruction` is
  // the lower-level escape hatch.
  const metadataIx = input.metadata
    ? buildTokenMetadataIx({
        mint: input.mint,
        mintAuthority: input.authority,
        payer: input.authority,
        name: input.metadata.name,
        symbol: input.metadata.symbol,
        ...(input.metadata.uri !== undefined ? { uri: input.metadata.uri } : {}),
        ...(input.metadata.sellerFeeBasisPoints !== undefined
          ? { sellerFeeBasisPoints: input.metadata.sellerFeeBasisPoints }
          : {}),
        ...(input.metadata.isMutable !== undefined ? { isMutable: input.metadata.isMutable } : {}),
      })
    : input.metadataInstruction;
  if (metadataIx !== undefined) {
    tokenInstructions.push(metadataIx);
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

/// The Metaplex Token Metadata program (mainnet + devnet).
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/// The metadata PDA for a mint: `["metadata", token_metadata_program, mint]`.
export function tokenMetadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export interface TokenMetadataInput {
  mint: PublicKey;
  /// The mint authority (signs).
  mintAuthority: PublicKey;
  /// Pays the metadata account rent (signs).
  payer: PublicKey;
  /// Recorded update authority; defaults to `mintAuthority`.
  updateAuthority?: PublicKey;
  name: string;
  symbol: string;
  /// Off-chain JSON URI (image, description). Default "".
  uri?: string;
  /// Royalty bps recorded in the metadata. Default 0.
  sellerFeeBasisPoints?: number;
  /// Whether the metadata can later be updated. Default true.
  isMutable?: boolean;
}

/// Build a Metaplex `CreateMetadataAccountV3` instruction so a launched token shows up
/// with a name / symbol / image in wallets and explorers. NOTE: this needs the Metaplex
/// Token Metadata program on-chain (present on devnet / mainnet, NOT on a bare local
/// validator), so it is a caller-supplied step, not part of the hermetic test suite.
/// Verify against the live program on devnet before mainnet.
export function buildTokenMetadataIx(input: TokenMetadataInput): TransactionInstruction {
  const [metadata] = tokenMetadataPda(input.mint);
  const name = borshString(input.name);
  const symbol = borshString(input.symbol);
  const uri = borshString(input.uri ?? "");
  // DataV2 tail: sellerFeeBasisPoints (u16) + creators/collection/uses (all None = 0) +
  // isMutable (bool) + collectionDetails (None = 0).
  const tail = new Uint8Array(2 + 1 + 1 + 1 + 1 + 1);
  new DataView(tail.buffer).setUint16(0, input.sellerFeeBasisPoints ?? 0, true);
  tail[5] = input.isMutable === false ? 0 : 1;
  // CreateMetadataAccountV3 discriminator (33) + DataV2 + isMutable + collectionDetails.
  const data = new Uint8Array(1 + name.length + symbol.length + uri.length + tail.length);
  data[0] = 33;
  let o = 1;
  for (const part of [name, symbol, uri, tail]) {
    data.set(part, o);
    o += part.length;
  }
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.mintAuthority, isSigner: true, isWritable: false },
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.updateAuthority ?? input.mintAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}
