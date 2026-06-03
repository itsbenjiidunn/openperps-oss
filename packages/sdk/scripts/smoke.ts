// End-to-end smoke test against a live cluster (default: devnet).
//
// Exercises the full production lifecycle on real accounts:
//   1. createAccount(market) + InitMarket   (manual oracle, synthetic asset)
//   2. CreateVault                           (SPL vault TokenAccount at the PDA)
//   3. ActivateMarket                        (seed the asset-slot mark)
//   4. CreateHouseVault + FundHouseVault     (the gated counterparty portfolio)
//   5. InitPortfolio + Deposit + Withdraw    (the user's [PORTFOLIO_SEED, owner,
//                                             market] PDA; real SPL custody)
//   6. AccrueAsset (delta-0 refresh) + PlaceOrder (user vs House)
// Then fetches every account and asserts the engine + token balances match the
// fee/PnL math exactly.
//
// Note: trades go through PlaceOrder (user portfolio vs the House PDA), not the
// raw self-cross Trade. Under the one-portfolio-per-(owner, market) PDA model a
// single owner cannot hold both sides, so the House is the counterparty.
//
// Run with:
//   cd packages/sdk && npm run smoke
//   # or: OPENPERPS_PAYER=C:\tmp\op-devnet\id.json node --import tsx scripts/smoke.ts
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
  createHouseVaultIx,
  createVaultIx,
  depositIx,
  fundHouseVaultIx,
  initMarketIx,
  initPortfolioIx,
  placeOrderIx,
  portfolioPda,
  withdrawIx,
  fetchMarketState,
  marketAccountSize,
  readU128LE,
  HOUSE_SEED,
  VAULT_SEED,
  OFFSET_VAULT,
  OFFSET_C_TOT,
  OFFSET_CAPITAL,
  ORACLE_KIND_MANUAL,
  Side,
} from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const ASSET_SLOT_CAPACITY = 2;
const POS_SCALE = 1_000_000n; // engine notional scale (size_q * price / POS_SCALE)
const ORACLE_PRICE = 100_000_000n; // u64 mark seeded at activation
const USER_DEPOSIT = 50_000_000n; // $50
const USER_WITHDRAW = 5_000_000n; // $5 demoed before the position opens
const HOUSE_FUND = 200_000_000n; // $200, comfortably covers the House margin
const TRADE_SIZE_Q = 1_000_000n; // notional = size_q * price / POS_SCALE = 1e8
const TRADE_FEE_BPS = 10n; // matches default_market_config.max_trading_fee_bps
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getComputeUnits(conn: Connection, sig: string): Promise<number | null> {
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
    resolve(REPO_ROOT, "target/deploy/openperps_program-keypair.json"),
  );
  const payer = loadKeypair(
    process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json"),
  );
  const programId = programKeypair.publicKey;

  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}`);
  console.log(`program=${programId.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  const balance = await conn.getBalance(payer.publicKey);
  console.log(`payer balance=${balance / 1e9} SOL`);

  const programInfo = await conn.getAccountInfo(programId);
  if (!programInfo) {
    throw new Error(
      `program ${programId.toBase58()} is not deployed on ${RPC}. ` +
        `Run \`solana program deploy target/deploy/openperps_program.so\` first.`,
    );
  }

  const market = Keypair.generate();
  const marketGroupId = randomBytes(32);

  // Mock-USDC mint (6 decimals) + a funded payer ATA covering both the user
  // deposit and the House funding, with headroom.
  console.log("creating mock-USDC mint...");
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log(`quote_mint=${quoteMint.toBase58()}`);
  const payerAta = await createAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
  const MINTED = 1_000_000_000n;
  await mintTo(conn, payer, quoteMint, payerAta, payer, MINTED);
  console.log(`payer ATA=${payerAta.toBase58()} (minted ${MINTED} atoms)`);

  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    programId,
  );
  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    programId,
  );
  const [userPf, userPfBump] = portfolioPda(programId, payer.publicKey, market.publicKey);
  console.log(`vault PDA=${vaultPda.toBase58()} (bump=${vaultBump})`);
  console.log(`house PDA=${housePda.toBase58()} (bump=${houseBump})`);
  console.log(`user portfolio PDA=${userPf.toBase58()} (bump=${userPfBump})`);

  const marketSize = marketAccountSize(ASSET_SLOT_CAPACITY);
  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);

  const sendTx = async (tx: Transaction, signers: Keypair[], label: string) => {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed",
    });
    console.log(`${label} tx=${sig}`);
    console.log(`  compute units=${await getComputeUnits(conn, sig)}`);
    return sig;
  };

  // ---- 1) Create market account + InitMarket ----
  await sendTx(
    new Transaction()
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
          baseMint: PublicKey.default, // synthetic asset, no underlying mint
          oracleKind: ORACLE_KIND_MANUAL,
          oracleFeedId: new Uint8Array(32),
          oraclePool: PublicKey.default,
        }),
      ),
    [payer, market],
    "InitMarket",
  );

  // ---- 2) Create the vault TokenAccount at the PDA ----
  await sendTx(
    new Transaction().add(
      createVaultIx({ programId, market: market.publicKey, authority: payer.publicKey, vault: vaultPda, quoteMint }),
    ),
    [payer],
    "CreateVault",
  );

  // ---- 3) Activate asset slot 0 (seeds the mark) ----
  await sendTx(
    new Transaction().add(
      activateMarketIx({
        programId,
        market: market.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        authenticatedPrice: ORACLE_PRICE,
      }),
    ),
    [payer],
    "ActivateMarket(slot0)",
  );

  // ---- 4) Create + fund the House (the gated counterparty) ----
  await sendTx(
    new Transaction().add(
      createHouseVaultIx({
        programId,
        market: market.publicKey,
        authority: payer.publicKey,
        housePortfolio: housePda,
        houseBump,
      }),
    ),
    [payer],
    "CreateHouseVault",
  );
  await sendTx(
    new Transaction().add(
      fundHouseVaultIx({
        programId,
        market: market.publicKey,
        housePortfolio: housePda,
        authority: payer.publicKey,
        authorityToken: payerAta,
        vaultToken: vaultPda,
        amount: HOUSE_FUND,
      }),
    ),
    [payer],
    "FundHouseVault",
  );

  // ---- 5) User portfolio (PDA) + Deposit + Withdraw ----
  await sendTx(
    new Transaction().add(
      initPortfolioIx({
        programId,
        portfolio: userPf,
        market: market.publicKey,
        owner: payer.publicKey,
        bump: userPfBump,
      }),
    ),
    [payer],
    "InitPortfolio",
  );
  await sendTx(
    new Transaction().add(
      depositIx({
        programId,
        market: market.publicKey,
        portfolio: userPf,
        owner: payer.publicKey,
        userToken: payerAta,
        vaultToken: vaultPda,
        amount: USER_DEPOSIT,
      }),
    ),
    [payer],
    "Deposit",
  );
  await sendTx(
    new Transaction().add(
      withdrawIx({
        programId,
        market: market.publicKey,
        portfolio: userPf,
        owner: payer.publicKey,
        vaultToken: vaultPda,
        userToken: payerAta,
        amount: USER_WITHDRAW,
      }),
    ),
    [payer],
    "Withdraw",
  );

  // ---- 6) Refresh slot_last (delta-0) then PlaceOrder (user long vs House) ----
  await sendTx(
    new Transaction().add(
      accrueAssetIx({
        programId,
        market: market.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        effectivePrice: ORACLE_PRICE,
        fundingRateE9: 0n,
      }),
    ),
    [payer],
    "AccrueAsset(refresh)",
  );

  // Source the execution price from the on-chain mark, never a client price.
  const { markPrice } = await fetchMarketState(conn, market.publicKey, 0);
  if (markPrice !== ORACLE_PRICE) {
    throw new Error(`unexpected mark: got=${markPrice} expected=${ORACLE_PRICE}`);
  }
  await sendTx(
    new Transaction().add(
      placeOrderIx({
        programId,
        market: market.publicKey,
        userPortfolio: userPf,
        housePortfolio: housePda,
        user: payer.publicKey,
        side: Side.Long,
        assetIndex: 0,
        sizeQ: TRADE_SIZE_Q,
        execPrice: markPrice,
        feeBps: TRADE_FEE_BPS,
      }),
    ),
    [payer],
    "PlaceOrder(long vs House)",
  );

  // ---- Verify on-chain state ----
  const marketAcct = await conn.getAccountInfo(market.publicKey);
  const userAcct = await conn.getAccountInfo(userPf);
  const houseAcct = await conn.getAccountInfo(housePda);
  if (!marketAcct || !userAcct || !houseAcct) {
    throw new Error("could not fetch market/user/house accounts after trade");
  }
  const vault = readU128LE(marketAcct.data, OFFSET_VAULT);
  const cTot = readU128LE(marketAcct.data, OFFSET_C_TOT);
  const userCapital = readU128LE(userAcct.data, OFFSET_CAPITAL);
  const houseCapital = readU128LE(houseAcct.data, OFFSET_CAPITAL);

  const vaultTok = await getAccount(conn, vaultPda);
  const payerTok = await getAccount(conn, payerAta);

  console.log("");
  console.log("on-chain state after PlaceOrder:");
  console.log(`  market.vault     = ${vault}`);
  console.log(`  market.c_tot     = ${cTot}`);
  console.log(`  user.capital     = ${userCapital}`);
  console.log(`  house.capital    = ${houseCapital}`);
  console.log(`  vault TokenAcct  = ${vaultTok.amount}`);
  console.log(`  payer TokenAcct  = ${payerTok.amount}`);

  // Engine math: opening at exec == mark realizes no PnL, only the per-side fee.
  //   notional = size_q * mark / POS_SCALE; fee = notional * fee_bps / 1e4.
  // The fee leaves each side's capital and c_tot, moving into insurance; the
  // engine `vault` is conserved across trades (only Deposit/Withdraw move it).
  const notional = (TRADE_SIZE_Q * markPrice) / POS_SCALE;
  const fee = (notional * TRADE_FEE_BPS) / 10_000n;
  const expectedVault = USER_DEPOSIT + HOUSE_FUND - USER_WITHDRAW;
  const expectedCTot = expectedVault - fee * 2n;
  const expectedUserCapital = USER_DEPOSIT - USER_WITHDRAW - fee;
  const expectedHouseCapital = HOUSE_FUND - fee;
  const expectedVaultTok = USER_DEPOSIT + HOUSE_FUND - USER_WITHDRAW;
  const expectedPayerTok = MINTED - USER_DEPOSIT - HOUSE_FUND + USER_WITHDRAW;

  const eq = (got: bigint, want: bigint, label: string) => {
    if (got !== want) throw new Error(`${label} mismatch: got=${got} expected=${want}`);
  };
  eq(vault, expectedVault, "engine vault");
  eq(cTot, expectedCTot, "c_tot");
  eq(userCapital, expectedUserCapital, "user capital");
  eq(houseCapital, expectedHouseCapital, "house capital");
  eq(vaultTok.amount, expectedVaultTok, "vault TokenAccount");
  eq(payerTok.amount, expectedPayerTok, "payer TokenAccount");

  console.log("");
  console.log("OK engine state matches: deposit + withdraw + House-funded trade fees consistent");
  console.log("OK real SPL custody: vault holds user + House collateral net of the withdrawal");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
