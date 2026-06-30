/// The launch aggregator: deploy a token via any `LaunchProvider` (Pump.fun / LetsBonk /
/// native), optionally add a real spot pool (any `SpotPoolProvider` venue), then stand up
/// a coin-margin OpenPerps perp on the token, all in one wallet flow. The perp is seeded by
/// the creator's dev-buy bag (external launchpads) or allocation (native), optionally
/// behind a rug-proof timelock.
///
/// Steps (each is one wallet approval):
///   upload    : (when an image is given) pin the metadata JSON to IPFS for the create tx
///   deploy    : the provider's create (+ dev-buy) transaction(s)
///   add-lp    : (optional) create the chosen spot pool (e.g. Raydium CPMM token/SOL)
///   seed-perp : create the coin-margin market + House, funded by the bag, activate
///   commit    : (optional) SetHouseLock to timelock the seed (rug-proof)
///
/// NOTE: the perp stays MANUAL (oracleAuthority-maintained). A token/SOL pool prices in
/// SOL, not USD, so it is NOT auto-bound as the perp oracle; oracle graduation (SetDexPool)
/// is a deliberate, separate step that only yields a USD mark from a USDC-quote pool.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildLaunchpadPerp,
  setHouseLockIx,
  houseLockPda,
  marketAccountSize,
  VAULT_SEED,
} from "@opp-oss/sdk";

import { PROGRAM_ID } from "../program";
import { addMarket } from "../registry";
import { postMarket } from "../indexer";
import type { DeployStep, LaunchProvider, TokenLaunchRequest } from "./types";
import type { MetadataUploader, TokenMetadataContent } from "./ipfs";
import { getSpotPoolProvider, type SpotPoolVenueId } from "./spotPool";

const COMMITMENT: Commitment = "confirmed";

export type AggregatorStep = "upload" | "deploy" | "add-lp" | "seed-perp" | "commit";

export interface AggregatorProgress {
  step: AggregatorStep;
  detail?: string;
  signature?: string;
}

/// How much of the bag seeds the perp House: a fraction of the bag (external dev-buy) or
/// an explicit atom amount (native, where the creator holds the whole supply).
export type PerpAllocation = { pctOfBag: number } | { atoms: bigint };

export interface AggregatorPerpConfig {
  allocation: PerpAllocation;
  /// Launch price (USD) the MANUAL mark is seeded at.
  launchPriceUsd: number;
  /// Optional rug-proof timelock: commit the seed for this many slots from now.
  lockForSlots?: number;
  /// Optional extra launch caps (small + reflexive markets want these low).
  houseCapBase?: bigint;
  depositCapAtoms?: bigint;
}

/// Optional spot pool to create alongside the launch (native path). token/SOL for now.
export interface AggregatorSpotLp {
  venue: SpotPoolVenueId;
  tokenAmount: bigint;
  solLamports: bigint;
}

export interface AggregatorResult {
  provider: string;
  mint: PublicKey;
  market: PublicKey;
  allocationAtoms: bigint;
  poolId?: PublicKey;
  signatures: Partial<Record<AggregatorStep, string>>;
}

export async function aggregatorLaunch(args: {
  wallet: WalletContextState;
  connection: Connection;
  provider: LaunchProvider;
  request: TokenLaunchRequest;
  perp: AggregatorPerpConfig;
  /// Optional spot pool to create (native path); skipped when absent.
  spotLp?: AggregatorSpotLp;
  /// Used to pin metadata when the request has no `metadataUri` and an image is given.
  uploader?: MetadataUploader | null;
  /// Optional token image to embed in the metadata JSON.
  image?: Blob;
  onProgress?: (p: AggregatorProgress) => void;
}): Promise<AggregatorResult> {
  const { wallet, connection, provider, perp, spotLp, uploader, image, onProgress } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Wallet is not connected.");
  const payer = wallet.publicKey;
  const ctx = { connection, wallet, payer };
  const progress = (p: AggregatorProgress) => onProgress?.(p);
  const sigs: Partial<Record<AggregatorStep, string>> = {};

  // 1) Metadata: pin a JSON when an image is supplied; external launchpads REQUIRE a URI.
  let request: TokenLaunchRequest = args.request;
  if (!request.metadataUri && image && uploader) {
    progress({ step: "upload", detail: "Pinning metadata to IPFS" });
    const content: TokenMetadataContent = {
      name: request.name,
      symbol: request.symbol,
      image,
    };
    request = { ...request, metadataUri: await uploader.uploadMetadata(content) };
  }
  if (!request.metadataUri && provider.fromDevBuy) {
    throw new Error(
      "This launchpad needs a metadata URI: provide an image + VITE_PINATA_JWT (or a pre-built metadataUri).",
    );
  }

  // 2) Deploy the token via the provider (one or more wallet approvals).
  progress({ step: "deploy", detail: `Creating on ${provider.label}` });
  const plan = await provider.deployToken(request, ctx);
  let lastDeploySig = "";
  for (const step of plan.steps) {
    lastDeploySig = await signAndSend(connection, wallet, step);
  }
  sigs.deploy = lastDeploySig;
  progress({ step: "deploy", detail: `${provider.label} token created`, signature: lastDeploySig });

  // 3) Optional spot pool (native path): real liquidity so the token is spot-tradeable.
  let poolId: PublicKey | undefined;
  if (spotLp) {
    progress({ step: "add-lp", detail: `Creating ${spotLp.venue} pool` });
    const pool = await getSpotPoolProvider(spotLp.venue).createPool(
      {
        mint: plan.mint,
        decimals: plan.decimals,
        pair: "sol",
        tokenAmount: spotLp.tokenAmount,
        solLamports: spotLp.solLamports,
      },
      ctx,
    );
    poolId = pool.poolId;
    sigs["add-lp"] = pool.signature;
    progress({ step: "add-lp", detail: "Spot pool live", signature: pool.signature });
  }

  // 4) Size the perp seed from the creator's remaining bag (after any LP deposit).
  const bag = BigInt(
    (await connection.getTokenAccountBalance(plan.creatorTokenAccount, COMMITMENT)).value.amount,
  );
  const allocationAtoms =
    "atoms" in perp.allocation
      ? perp.allocation.atoms
      : (bag * BigInt(Math.round(Math.max(0, Math.min(1, perp.allocation.pctOfBag)) * 10_000))) /
        10_000n;
  if (allocationAtoms <= 0n) throw new Error("Perp allocation is zero; raise it or the dev-buy.");
  if (allocationAtoms > bag) {
    throw new Error("Perp allocation exceeds the creator's remaining bag (LP took too much).");
  }

  // 5) The coin-margin perp on the freshly launched token, seeded by the allocation.
  progress({ step: "seed-perp", detail: "Standing up the coin-margin perp" });
  const market = Keypair.generate();
  const marketRent = await connection.getMinimumBalanceForRentExemption(marketAccountSize(1));
  const listing = buildLaunchpadPerp({
    programId: PROGRAM_ID,
    authority: payer,
    market: market.publicKey,
    marketRentLamports: marketRent,
    token: plan.mint,
    symbol: request.symbol,
    name: request.name,
    launchPriceUsd: perp.launchPriceUsd,
    allocationAtoms,
    authorityTokenAccount: plan.creatorTokenAccount,
    ...(perp.houseCapBase !== undefined ? { houseCapBase: perp.houseCapBase } : {}),
    ...(perp.depositCapAtoms !== undefined ? { depositCapAtoms: perp.depositCapAtoms } : {}),
  });
  const ix = listing.instructions;
  let lastPerpSig = await sendLegacy(connection, wallet, ix.slice(0, 2), [market]);
  for (let i = 2; i < ix.length; i += 3) {
    lastPerpSig = await sendLegacy(connection, wallet, ix.slice(i, i + 3), []);
  }
  sigs["seed-perp"] = lastPerpSig;
  progress({ step: "seed-perp", detail: "Perp live", signature: lastPerpSig });

  // 6) Optional rug-proof timelock on the seed.
  if (perp.lockForSlots && perp.lockForSlots > 0) {
    progress({ step: "commit", detail: "Locking the House seed" });
    const slot = await connection.getSlot(COMMITMENT);
    const [pda, bump] = houseLockPda(PROGRAM_ID, market.publicKey);
    sigs.commit = await sendLegacy(
      connection,
      wallet,
      [
        setHouseLockIx({
          programId: PROGRAM_ID,
          houseLockPda: pda,
          market: market.publicKey,
          authority: payer,
          unlockSlot: BigInt(slot + perp.lockForSlots),
          bump,
        }),
      ],
      [],
    );
    progress({ step: "commit", detail: "Seed locked", signature: sigs.commit });
  }

  const vault = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  )[0].toBase58();
  // Assigned to a variable first so extra fields (coinMargin / launchpad / spotPool) are
  // kept (TS only excess-property-checks fresh literals passed directly), like launchpadFlow.
  const entry = {
    pubkey: market.publicKey.toBase58(),
    symbol: request.symbol,
    base: request.symbol,
    quoteMint: plan.mint.toBase58(),
    vault,
    assetSlotCapacity: 1,
    assetIndex: 0,
    baseMint: plan.mint.toBase58(),
    oracleKind: "manual" as const,
    maxLeverage: 5,
    seedPriceUsd: perp.launchPriceUsd,
    ownGroup: true,
    coinMargin: true,
    seedLp: Number(allocationAtoms) / 10 ** plan.decimals,
    launchpad: provider.id,
    ...(poolId ? { spotPool: poolId.toBase58() } : {}),
  };
  addMarket(entry);
  void postMarket(entry);

  return {
    provider: provider.id,
    mint: plan.mint,
    market: market.publicKey,
    allocationAtoms,
    ...(poolId ? { poolId } : {}),
    signatures: sigs,
  };
}

// ---- send helpers ----

/// Send one provider step. A `VersionedTransaction` already carries a recent blockhash, so
/// we pre-sign it with the extra signers (the mint keypair) and let the wallet add its own
/// signature; a legacy `Transaction` goes through `sendLegacy` (we set the blockhash).
async function signAndSend(
  connection: Connection,
  wallet: WalletContextState,
  step: DeployStep,
): Promise<string> {
  if (step.tx instanceof VersionedTransaction) {
    if (step.signers?.length) step.tx.sign(step.signers);
    const sig = await wallet.sendTransaction!(step.tx, connection);
    await connection.confirmTransaction(sig, COMMITMENT);
    return sig;
  }
  return sendLegacy(connection, wallet, step.tx.instructions, step.signers ?? []);
}

async function sendLegacy(
  connection: Connection,
  wallet: WalletContextState,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);
  const tx = new Transaction().add(...instructions);
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey!;
  const sig = await wallet.sendTransaction!(tx, connection, { signers: extraSigners });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, COMMITMENT);
  return sig;
}
