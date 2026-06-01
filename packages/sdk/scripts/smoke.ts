// End-to-end smoke test against a live cluster (default: devnet).
//
// Reads the program keypair the SBF build emitted at ../../deploy/ and a
// payer wallet from ~/.config/solana/id.json (Solana CLI default). Sends:
//   1. createAccount(market) + InitMarket
//   2. createAccount(portfolio) + InitPortfolio
//   3. Deposit
// Then fetches the two accounts and reports the engine state plus the
// compute-units consumed by each transaction.
//
// Run with:
//   cd ts/sdk && npm install && npm run smoke
//
// Override the RPC with $OPENPERPS_RPC, e.g. http://127.0.0.1:8899 for localnet.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  accrueAssetIx,
  activateMarketIx,
  createVaultIx,
  depositIx,
  initMarketIx,
  initPortfolioIx,
  marketAccountSize,
  portfolioAccountSize,
  tradeIx,
  withdrawIx,
  OFFSET_VAULT,
  OFFSET_C_TOT,
  OFFSET_CAPITAL,
  VAULT_SEED,
  readU128LE,
} from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const ASSET_SLOT_CAPACITY = 2;
const DEPOSIT_AMOUNT = 50_000_000n; // 5e7 — comfortably above the trade's 1e7 margin
const WITHDRAW_AMOUNT = 5_000_000n; // demoed on the long side before Trade
const ORACLE_PRICE = 100_000_000n; // u64; arbitrary trusted price for slot 0
const REFRESHED_PRICE = 105_000_000n; // u64; a +5% move for the accrue refresh
const TRADE_SIZE_Q = 1_000_000n; // notional = size_q * price / 1e6 = 1e8
const TRADE_FEE_BPS = 10n; // matches default_market_config.max_trading_fee_bps
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getComputeUnits(
  conn: Connection,
  sig: string,
): Promise<number | null> {
  // Allow the cluster a moment to surface the tx in its history index.
  for (let i = 0; i < 5; i++) {
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta?.computeUnitsConsumed != null) return tx.meta.computeUnitsConsumed;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main(): Promise<void> {
  const programKeypair = loadKeypair(
    resolve(REPO_ROOT, "deploy/openperps_program-keypair.json"),
  );
  const payer = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const programId = programKeypair.publicKey;

  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}`);
  console.log(`program=${programId.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  const balance = await conn.getBalance(payer.publicKey);
  console.log(`payer balance=${balance / 1e9} SOL`);

  // Sanity: program must already be deployed.
  const programInfo = await conn.getAccountInfo(programId);
  if (!programInfo) {
    throw new Error(
      `program ${programId.toBase58()} is not deployed on ${RPC}. ` +
        `Run \`solana program deploy deploy/openperps_program.so\` first.`,
    );
  }

  const market = Keypair.generate();
  const longPortfolio = Keypair.generate();
  const shortPortfolio = Keypair.generate();
  const marketGroupId = randomBytes(32);
  const longPfId = randomBytes(32);
  const shortPfId = randomBytes(32);

  // Phase B: create a real SPL mint (mock-USDC, 6 decimals) and mint the
  // payer enough collateral to cover Deposit + Trade margin + fees.
  console.log("creating mock-USDC mint...");
  const quoteMint = await createMint(
    conn,
    payer,
    /*mintAuthority*/ payer.publicKey,
    /*freezeAuthority*/ null,
    /*decimals*/ 6,
  );
  console.log(`quote_mint=${quoteMint.toBase58()}`);

  // ATA the payer will use to fund both long and short deposits.
  const payerAta = await createAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
  await mintTo(conn, payer, quoteMint, payerAta, payer, /*amount*/ 1_000_000_000n);
  console.log(`payer ATA=${payerAta.toBase58()} (minted 1,000,000,000 atoms)`);

  // Vault PDA = [b"vault", market.key()]. Client finds the bump off-chain;
  // the on-chain handler verifies via create_program_address.
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    programId,
  );
  console.log(`vault PDA=${vaultPda.toBase58()} (bump=${vaultBump})`);

  const marketSize = marketAccountSize(ASSET_SLOT_CAPACITY);
  const portfolioSize = portfolioAccountSize(ASSET_SLOT_CAPACITY);
  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);
  const portfolioRent = await conn.getMinimumBalanceForRentExemption(portfolioSize);
  console.log(
    `market account: ${marketSize} bytes, rent=${marketRent / 1e9} SOL`,
  );
  console.log(
    `portfolio account: ${portfolioSize} bytes, rent=${portfolioRent / 1e9} SOL`,
  );

  // ---- 1) Create market account + InitMarket ----
  const tx1 = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: market.publicKey,
        lamports: marketRent,
        space: marketSize,
        programId,
      }),
    )
    .add(
      initMarketIx({
        programId,
        market: market.publicKey,
        authority: payer.publicKey,
        quoteMint,
        marketGroupId,
        assetSlotCapacity: ASSET_SLOT_CAPACITY,
        vaultBump,
        // Smoke uses a manual oracle and no underlying mint (synthetic).
        baseMint: PublicKey.default,
        oracleKind: 0,
        oracleFeedId: new Uint8Array(32),
        oraclePool: PublicKey.default,
      }),
    );
  const sig1 = await sendAndConfirmTransaction(conn, tx1, [payer, market]);
  console.log(`InitMarket tx=${sig1}`);
  console.log(`  compute units=${await getComputeUnits(conn, sig1)}`);

  // ---- 1b) Create the vault TokenAccount at the PDA ----
  const tx1b = new Transaction().add(
    createVaultIx({
      programId,
      market: market.publicKey,
      authority: payer.publicKey,
      vault: vaultPda,
      quoteMint,
    }),
  );
  const sig1b = await sendAndConfirmTransaction(conn, tx1b, [payer]);
  console.log(`CreateVault tx=${sig1b}`);
  console.log(`  compute units=${await getComputeUnits(conn, sig1b)}`);

  // ---- 2) Create + init the long and short portfolios ----
  const createAndInitPortfolio = async (
    keypair: Keypair,
    id: Uint8Array,
    label: string,
  ): Promise<void> => {
    const tx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: keypair.publicKey,
          lamports: portfolioRent,
          space: portfolioSize,
          programId,
        }),
      )
      .add(
        initPortfolioIx({
          programId,
          portfolio: keypair.publicKey,
          market: market.publicKey,
          owner: payer.publicKey,
          portfolioAccountId: id,
        }),
      );
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, keypair]);
    console.log(`InitPortfolio (${label}) tx=${sig}`);
    console.log(`  compute units=${await getComputeUnits(conn, sig)}`);
  };
  await createAndInitPortfolio(longPortfolio, longPfId, "long");
  await createAndInitPortfolio(shortPortfolio, shortPfId, "short");

  // ---- 3) Activate asset slot 0 ----
  const tx3a = new Transaction().add(
    activateMarketIx({
      programId,
      market: market.publicKey,
      authority: payer.publicKey,
      assetIndex: 0,
      authenticatedPrice: ORACLE_PRICE,
    }),
  );
  const sig3a = await sendAndConfirmTransaction(conn, tx3a, [payer]);
  console.log(`ActivateMarket tx=${sig3a}`);
  console.log(`  compute units=${await getComputeUnits(conn, sig3a)}`);

  // ---- 4) Refresh oracle + funding for the active slot ----
  const tx3b = new Transaction().add(
    accrueAssetIx({
      programId,
      market: market.publicKey,
      authority: payer.publicKey,
      assetIndex: 0,
      effectivePrice: REFRESHED_PRICE,
      fundingRateE9: 0n,
    }),
  );
  const sig3b = await sendAndConfirmTransaction(conn, tx3b, [payer]);
  console.log(`AccrueAsset tx=${sig3b}`);
  console.log(`  compute units=${await getComputeUnits(conn, sig3b)}`);

  // ---- 5) Deposit into both portfolios (real SPL token transfer to vault) ----
  const depositInto = async (
    portfolioKey: PublicKey,
    label: string,
  ): Promise<void> => {
    const tx = new Transaction().add(
      depositIx({
        programId,
        market: market.publicKey,
        portfolio: portfolioKey,
        owner: payer.publicKey,
        userToken: payerAta,
        vaultToken: vaultPda,
        amount: DEPOSIT_AMOUNT,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    console.log(`Deposit (${label}) tx=${sig}`);
    console.log(`  compute units=${await getComputeUnits(conn, sig)}`);
  };
  await depositInto(longPortfolio.publicKey, "long");
  await depositInto(shortPortfolio.publicKey, "short");

  // ---- 5b) Withdraw a slice from the long portfolio before any position
  //          is opened. Engine requires active_bitmap empty; vault PDA
  //          signs the SPL Token.Transfer out via invoke_signed.
  const txW = new Transaction().add(
    withdrawIx({
      programId,
      market: market.publicKey,
      portfolio: longPortfolio.publicKey,
      owner: payer.publicKey,
      vaultToken: vaultPda,
      userToken: payerAta,
      amount: WITHDRAW_AMOUNT,
    }),
  );
  const sigW = await sendAndConfirmTransaction(conn, txW, [payer]);
  console.log(`Withdraw (long) tx=${sigW}`);
  console.log(`  compute units=${await getComputeUnits(conn, sigW)}`);

  // ---- 6) Trade: matched long/short cross ----
  const tx6 = new Transaction().add(
    tradeIx({
      programId,
      market: market.publicKey,
      longPortfolio: longPortfolio.publicKey,
      shortPortfolio: shortPortfolio.publicKey,
      authority: payer.publicKey,
      assetIndex: 0,
      sizeQ: TRADE_SIZE_Q,
      execPrice: REFRESHED_PRICE,
      feeBps: TRADE_FEE_BPS,
    }),
  );
  const sig6 = await sendAndConfirmTransaction(conn, tx6, [payer]);
  console.log(`Trade tx=${sig6}`);
  console.log(`  compute units=${await getComputeUnits(conn, sig6)}`);

  // ---- Verify on-chain state ----
  const marketAcct = await conn.getAccountInfo(market.publicKey);
  const longAcct = await conn.getAccountInfo(longPortfolio.publicKey);
  const shortAcct = await conn.getAccountInfo(shortPortfolio.publicKey);
  if (!marketAcct || !longAcct || !shortAcct) {
    throw new Error("could not fetch market/portfolio accounts after trade");
  }
  const vault = readU128LE(marketAcct.data, OFFSET_VAULT);
  const cTot = readU128LE(marketAcct.data, OFFSET_C_TOT);
  const longCapital = readU128LE(longAcct.data, OFFSET_CAPITAL);
  const shortCapital = readU128LE(shortAcct.data, OFFSET_CAPITAL);

  // SPL token balances — these are u64 atoms on the actual TokenAccounts.
  const vaultTok = await getAccount(conn, vaultPda);
  const payerTok = await getAccount(conn, payerAta);

  console.log("");
  console.log("on-chain state after trade:");
  console.log(`  market.vault     = ${vault}`);
  console.log(`  market.c_tot     = ${cTot}`);
  console.log(`  long.capital     = ${longCapital}`);
  console.log(`  short.capital    = ${shortCapital}`);
  console.log(`  vault TokenAcct  = ${vaultTok.amount}`);
  console.log(`  payer TokenAcct  = ${payerTok.amount}`);

  // Engine math:
  //   notional = TRADE_SIZE_Q * REFRESHED_PRICE / POS_SCALE(1e6)
  //   fee per side = notional * TRADE_FEE_BPS / 10_000
  // Fee leaves account.capital and market.c_tot, moves into market.insurance —
  // engine `vault` is conserved across trades; only Deposit/Withdraw move it.
  const notional = (TRADE_SIZE_Q * REFRESHED_PRICE) / 1_000_000n;
  const expectedFee = (notional * TRADE_FEE_BPS) / 10_000n;
  const expectedVaultEngine = DEPOSIT_AMOUNT * 2n - WITHDRAW_AMOUNT;
  const expectedCTot = expectedVaultEngine - expectedFee * 2n;
  const expectedLongCapital = DEPOSIT_AMOUNT - WITHDRAW_AMOUNT - expectedFee;
  const expectedShortCapital = DEPOSIT_AMOUNT - expectedFee;
  if (vault !== expectedVaultEngine) {
    throw new Error(`vault mismatch: got=${vault} expected=${expectedVaultEngine}`);
  }
  if (cTot !== expectedCTot) {
    throw new Error(`c_tot mismatch: got=${cTot} expected=${expectedCTot}`);
  }
  if (longCapital !== expectedLongCapital) {
    throw new Error(
      `long capital mismatch: got=${longCapital} expected=${expectedLongCapital}`,
    );
  }
  if (shortCapital !== expectedShortCapital) {
    throw new Error(
      `short capital mismatch: got=${shortCapital} expected=${expectedShortCapital}`,
    );
  }

  // SPL vault token balance = deposits - withdrawals (atomic units).
  const expectedVaultTok = DEPOSIT_AMOUNT * 2n - WITHDRAW_AMOUNT;
  const expectedPayerTok = 1_000_000_000n - DEPOSIT_AMOUNT * 2n + WITHDRAW_AMOUNT;
  if (vaultTok.amount !== expectedVaultTok) {
    throw new Error(
      `vault TokenAccount mismatch: got=${vaultTok.amount} expected=${expectedVaultTok}`,
    );
  }
  if (payerTok.amount !== expectedPayerTok) {
    throw new Error(
      `payer TokenAccount mismatch: got=${payerTok.amount} expected=${expectedPayerTok}`,
    );
  }
  console.log("? engine state matches: deposit + withdraw + trade-fees consistent");
  console.log("? real SPL token custody: vault drained on withdraw, payer credited");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
