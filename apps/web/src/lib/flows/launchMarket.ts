/// Launch a custom SPL perp as its OWN isolated market group (the
/// mainnet-correct model): the creator creates a fresh group + vault + House
/// and SEEDS the House with their own mUSDC. That seed is the LP + insurance
/// backing the market, trades match against THIS group's House, never the
/// shared majors pool, so a manipulable long-tail oracle can only drain the
/// liquidity its creator put up, not everyone else's.
///
/// Steps (each one tx / one wallet approval):
///   1. init-group : createAccount(market) + InitMarket(capacity, authority)
///   2. seed-house : CreateVault + CreateHouseVault + FundHouseVault(seed)
///   3. create-pool: (DEX only) create + seed the mock constant-product pool
///   4. activate   : ActivateMarket(slot 0 @ seed price) + (DEX) PinOraclePool

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  activateMarketIx,
  createHouseVaultIx,
  createMockPoolIx,
  createVaultIx,
  fundHouseVaultIx,
  initMarketIx,
  marketAccountSize,
  MOCK_POOL_SIZE,
  ORACLE_KIND_DEX_EWMA,
  ORACLE_KIND_MANUAL,
  pinOraclePoolIx,
  HOUSE_SEED,
  VAULT_SEED,
} from "@openperps/sdk";

import { PROGRAM_ID } from "../program";
import { QUOTE_MINT } from "../collateral";
import { addMarket } from "../registry";
import { postMarket } from "../indexer";

export type LaunchStepName = "init-group" | "seed-house" | "create-pool" | "activate";

export type LaunchProgress = {
  step: LaunchStepName;
  signature?: string;
};

export type LaunchParams = {
  symbol: string;
  base: string;
  baseMint?: string;
  oracleKind: "manual" | "dex";
  maxLeverage: number;
  feeBps: number;
  seedPriceUsd: number;
  /// Initial mark price written into slot 0 by ActivateMarket. u64 atoms.
  initialPrice: bigint;
  /// mUSDC (quote atoms) the creator seeds into the group's House (LP + insurance).
  seedLpAtoms: bigint;
  /// Asset-slot capacity of the new group. A custom market needs only a few.
  assetSlotCapacity: number;
};

export type LaunchResult = {
  market: PublicKey;
  vault: PublicKey;
  house: PublicKey;
  assetIndex: number;
  pool: PublicKey | null;
  signatures: Partial<Record<LaunchStepName, string>>;
};

const CONFIRM_COMMITMENT: Commitment = "confirmed";
const POOL_BASE_DEPTH = 1_000_000_000n;

function rnd32(): Uint8Array {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return a;
}

export async function launchMarket(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: LaunchParams;
  onProgress: (p: LaunchProgress) => void;
}): Promise<LaunchResult> {
  const { wallet, connection, params, onProgress } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const payer = wallet.publicKey;
  const programId = PROGRAM_ID;
  const isDex = params.oracleKind === "dex";
  const sigs: Partial<Record<LaunchStepName, string>> = {};

  const market = Keypair.generate();
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    programId,
  );
  const [house, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    programId,
  );
  const baseMint = params.baseMint ? new PublicKey(params.baseMint) : PublicKey.default;
  const userToken = getAssociatedTokenAddressSync(QUOTE_MINT, payer);

  // ---------- 1) create the group account + InitMarket ----------
  onProgress({ step: "init-group" });
  const size = marketAccountSize(params.assetSlotCapacity);
  const rent = await connection.getMinimumBalanceForRentExemption(size);
  const initTx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: market.publicKey,
        lamports: rent,
        space: size,
        programId,
      }),
    )
    .add(
      initMarketIx({
        programId,
        market: market.publicKey,
        authority: payer,
        quoteMint: QUOTE_MINT,
        marketGroupId: rnd32(),
        assetSlotCapacity: params.assetSlotCapacity,
        vaultBump,
        baseMint,
        oracleKind: isDex ? ORACLE_KIND_DEX_EWMA : ORACLE_KIND_MANUAL,
        oracleFeedId: new Uint8Array(32),
        oraclePool: PublicKey.default,
      }),
    );
  sigs["init-group"] = await sendAndConfirm(connection, wallet, initTx, [market]);
  onProgress({ step: "init-group", signature: sigs["init-group"] });

  // ---------- 2) vault + House + seed the House with the creator's mUSDC ----------
  onProgress({ step: "seed-house" });
  const seedTx = new Transaction()
    .add(
      createVaultIx({
        programId,
        market: market.publicKey,
        authority: payer,
        vault,
        quoteMint: QUOTE_MINT,
      }),
    )
    .add(
      createHouseVaultIx({
        programId,
        market: market.publicKey,
        authority: payer,
        housePortfolio: house,
        houseBump,
      }),
    )
    .add(
      fundHouseVaultIx({
        programId,
        market: market.publicKey,
        housePortfolio: house,
        authority: payer,
        authorityToken: userToken,
        vaultToken: vault,
        amount: params.seedLpAtoms,
      }),
    );
  sigs["seed-house"] = await sendAndConfirm(connection, wallet, seedTx);
  onProgress({ step: "seed-house", signature: sigs["seed-house"] });

  // ---------- 3) (DEX) create + seed the mock pool ----------
  let poolPubkey: PublicKey | null = null;
  if (isDex) {
    onProgress({ step: "create-pool" });
    const poolKp = Keypair.generate();
    poolPubkey = poolKp.publicKey;
    const reserveBase = POOL_BASE_DEPTH;
    const reserveQuote =
      (reserveBase * params.initialPrice) / 1_000_000n > 0n
        ? (reserveBase * params.initialPrice) / 1_000_000n
        : 1n;
    const poolRent = await connection.getMinimumBalanceForRentExemption(MOCK_POOL_SIZE);
    const poolTx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: poolKp.publicKey,
          lamports: poolRent,
          space: MOCK_POOL_SIZE,
          programId,
        }),
      )
      .add(
        createMockPoolIx({
          programId,
          pool: poolKp.publicKey,
          authority: payer,
          baseMint,
          quoteMint: QUOTE_MINT,
          reserveBase,
          reserveQuote,
        }),
      );
    sigs["create-pool"] = await sendAndConfirm(connection, wallet, poolTx, [poolKp]);
    onProgress({ step: "create-pool", signature: sigs["create-pool"] });
  }

  // ---------- 4) ActivateMarket(slot 0) + (DEX) PinOraclePool ----------
  onProgress({ step: "activate" });
  const actTx = new Transaction().add(
    activateMarketIx({
      programId,
      market: market.publicKey,
      authority: payer,
      assetIndex: 0,
      authenticatedPrice: params.initialPrice,
    }),
  );
  if (isDex && poolPubkey) {
    actTx.add(
      pinOraclePoolIx({
        programId,
        market: market.publicKey,
        pool: poolPubkey,
        signer: payer,
        assetIndex: 0,
      }),
    );
  }
  sigs["activate"] = await sendAndConfirm(connection, wallet, actTx);
  onProgress({ step: "activate", signature: sigs["activate"] });

  const entry = {
    pubkey: market.publicKey.toBase58(),
    symbol: params.symbol,
    base: params.base,
    quoteMint: QUOTE_MINT.toBase58(),
    vault: vault.toBase58(),
    assetSlotCapacity: params.assetSlotCapacity,
    assetIndex: 0,
    baseMint: params.baseMint,
    oracleKind: params.oracleKind,
    oraclePool: poolPubkey ? poolPubkey.toBase58() : undefined,
    maxLeverage: params.maxLeverage,
    feeBps: params.feeBps,
    seedPriceUsd: params.seedPriceUsd,
    ownGroup: true,
    house: house.toBase58(),
    houseBump,
    seedLp: Number(params.seedLpAtoms) / 1_000_000,
  };
  // Write the local registry (instant for the launcher) AND publish to the
  // shared indexer so every other wallet/device discovers it too. The POST is
  // best-effort: if it fails, the launch still succeeded on-chain and the
  // creator keeps it locally.
  addMarket(entry);
  void postMarket(entry);

  return {
    market: market.publicKey,
    vault,
    house,
    assetIndex: 0,
    pool: poolPubkey,
    signatures: sigs,
  };
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
