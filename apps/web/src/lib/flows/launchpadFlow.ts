/// OPP Launchpad flow: mint a fresh token AND launch a coin-margin perp on it in one
/// wallet flow. Instead of locking the creator allocation, it seeds the perp House with
/// it (productive liquidity that earns the House edge), and optionally commits that seed
/// behind a rug-proof timelock.
///
/// Steps (each one tx / one wallet approval):
///   1. mint-token : create the SPL mint + supply (+ optional metadata, + revoke
///                   mint authority for a fixed supply)
///   2. launch     : create the coin-margin market + vault + House, fund the House with
///                   the allocation, activate at the launch price, set the safe profile
///   3. commit     : (optional) SetHouseLock to timelock the House seed (rug-proof)

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { MINT_SIZE } from "@solana/spl-token";
import {
  buildTokenLaunchWithPerp,
  setHouseLockIx,
  houseLockPda,
  marketAccountSize,
  VAULT_SEED,
} from "@opp-oss/sdk";

import { PROGRAM_ID } from "../program";
import { addMarket } from "../registry";
import { postMarket } from "../indexer";

const CONFIRM_COMMITMENT: Commitment = "confirmed";

export type LaunchpadStepName = "mint-token" | "launch" | "commit";

export type LaunchpadProgress = {
  step: LaunchpadStepName;
  signature?: string;
};

export type LaunchpadParams = {
  name: string;
  symbol: string;
  decimals: number;
  /// Total supply minted to the creator, in token atoms.
  totalSupply: bigint;
  /// The slice of the supply that seeds the perp House, in token atoms.
  allocationAtoms: bigint;
  /// Launch price in USD (the MANUAL mark is seeded here).
  launchPriceUsd: number;
  /// Drop the mint authority after minting (fixed supply). Default true.
  revokeMintAuthority?: boolean;
  /// Optional Metaplex metadata (needs the Metaplex program; devnet / mainnet only).
  metadata?: { name: string; symbol: string; uri?: string };
  /// Optional rug-proof timelock: commit the House seed for this many slots from now.
  lockForSlots?: number;
};

export type LaunchpadResult = {
  mint: PublicKey;
  market: PublicKey;
  signatures: Partial<Record<LaunchpadStepName, string>>;
};

export async function launchpad(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: LaunchpadParams;
  onProgress: (p: LaunchpadProgress) => void;
}): Promise<LaunchpadResult> {
  const { wallet, connection, params, onProgress } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const payer = wallet.publicKey;
  const sigs: Partial<Record<LaunchpadStepName, string>> = {};

  const mint = Keypair.generate();
  const market = Keypair.generate();
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const marketRent = await connection.getMinimumBalanceForRentExemption(marketAccountSize(1));

  const launch = buildTokenLaunchWithPerp({
    programId: PROGRAM_ID,
    authority: payer,
    mint: mint.publicKey,
    mintRentLamports: mintRent,
    decimals: params.decimals,
    totalSupply: params.totalSupply,
    revokeMintAuthority: params.revokeMintAuthority ?? true,
    market: market.publicKey,
    marketRentLamports: marketRent,
    allocationAtoms: params.allocationAtoms,
    launchPriceUsd: params.launchPriceUsd,
    symbol: params.symbol,
    name: params.name,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });

  // 1) mint the token + supply (the mint keypair signs its account creation).
  onProgress({ step: "mint-token" });
  sigs["mint-token"] = await sendAndConfirm(
    connection,
    wallet,
    new Transaction().add(...launch.tokenInstructions),
    [mint],
  );
  onProgress({ step: "mint-token", signature: sigs["mint-token"] });

  // 2) the perp launch. Account creation is first (needs the market keypair); send it
  // with that signer, then the rest in small chunks under the tx size limit.
  onProgress({ step: "launch" });
  const ix = launch.listing.instructions;
  let lastLaunchSig = "";
  lastLaunchSig = await sendAndConfirm(
    connection,
    wallet,
    new Transaction().add(...ix.slice(0, 2)),
    [market],
  );
  for (let i = 2; i < ix.length; i += 3) {
    lastLaunchSig = await sendAndConfirm(
      connection,
      wallet,
      new Transaction().add(...ix.slice(i, i + 3)),
    );
  }
  sigs["launch"] = lastLaunchSig;
  onProgress({ step: "launch", signature: lastLaunchSig });

  // 3) optional rug-proof timelock on the House seed.
  if (params.lockForSlots && params.lockForSlots > 0) {
    onProgress({ step: "commit" });
    const slot = await connection.getSlot(CONFIRM_COMMITMENT);
    const unlockSlot = BigInt(slot + params.lockForSlots);
    const [pda, bump] = houseLockPda(PROGRAM_ID, market.publicKey);
    sigs["commit"] = await sendAndConfirm(
      connection,
      wallet,
      new Transaction().add(
        setHouseLockIx({
          programId: PROGRAM_ID,
          houseLockPda: pda,
          market: market.publicKey,
          authority: payer,
          unlockSlot,
          bump,
        }),
      ),
    );
    onProgress({ step: "commit", signature: sigs["commit"] });
  }

  const entry = {
    pubkey: market.publicKey.toBase58(),
    symbol: params.symbol,
    base: params.symbol,
    quoteMint: mint.publicKey.toBase58(),
    vault: PublicKey.findProgramAddressSync(
      [VAULT_SEED, market.publicKey.toBuffer()],
      PROGRAM_ID,
    )[0].toBase58(),
    assetSlotCapacity: 1,
    assetIndex: 0,
    baseMint: mint.publicKey.toBase58(),
    oracleKind: "manual" as const,
    maxLeverage: 5,
    seedPriceUsd: params.launchPriceUsd,
    ownGroup: true,
    coinMargin: true,
    seedLp: Number(params.allocationAtoms) / 10 ** params.decimals,
  };
  addMarket(entry);
  void postMarket(entry);

  return { mint: mint.publicKey, market: market.publicKey, signatures: sigs };
}

async function sendAndConfirm(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey!;
  const sig = await wallet.sendTransaction(tx, connection, { signers: extraSigners });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return sig;
}
