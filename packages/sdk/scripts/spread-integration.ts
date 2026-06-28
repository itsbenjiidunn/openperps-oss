// On-chain integration test for the optional dynamic fee spread (price impact +
// inventory skew), against a deployed program. Part of the on-chain suite (see
// scripts/run-onchain-suite.sh).
//
// Proves on real accounts (what host tests cannot: the SetRiskConfig PDA actually
// carries the spread factors, the trade handler reads the House depth/inventory and
// adds the surcharge to the fee that hits the chain):
//   - a market with the price-impact spread ON charges strictly MORE fee than an
//     identical market with it OFF, by EXACTLY the predicted impact amount,
//   - default-OFF (no risk config) behaves like the baseline (the OFF market),
//   - a pile-on into the crowded side (risk-increasing) pays a skew surcharge on top,
//     while the first (House-flat) trade does not.
//
// The fee is measured as the drop in the user portfolio `capital` across one trade.
// Part 1 compares two IDENTICAL fresh markets, so any non-fee capital movement (margin
// on open) cancels and the difference isolates the spread exactly. Skew arithmetic is
// also covered exhaustively by host unit tests in crates/program/src/state.rs.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
  mintTo,
} from "@solana/spl-token";
import {
  initMarketIx,
  createVaultIx,
  createHouseVaultIx,
  fundHouseVaultIx,
  activateMarketIx,
  initPortfolioIx,
  depositIx,
  placeOrderIx,
  setRiskConfigIx,
  riskConfigPda,
  portfolioPda,
  marketAccountSize,
  decodePortfolioSummary,
  Side,
  VAULT_SEED,
  HOUSE_SEED,
  ORACLE_KIND_MANUAL,
  DEVNET_PROGRAM_ID,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey(
  process.env.OPENPERPS_PROGRAM_ID ?? DEVNET_PROGRAM_ID,
);
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH =
  process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");

const CAP = 1;
const UNIT = 1_000_000n;
const PRICE = 100_000_000n; // mark at the 1e6 price scale ($100)
const HOUSE_FUND = 50n * UNIT; // House marked equity = 50 mUSDC (fresh: pnl 0)
const LONG = 200_000n; // notional = LONG * PRICE / 1e6 = 20 mUSDC
const FEE = 10n; // base fee bps
const IMPACT_K = 100n; // impact_bps = notional * K / equity = 20e6 * 100 / 50e6 = 40 bps
const MAX_SPREAD = 500n;
// User-leg fee = ceil(notional * bps / 10000). Off: 20e6*10/10000 = 20_000. On (50 bps):
// 20e6*50/10000 = 100_000. The differential is the pure impact surcharge.
const EXPECTED_IMPACT_FEE = 80_000n;

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}
async function send(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<void> {
  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
  });
  console.log(`  ${label} tx=${sig}`);
}
async function capital(conn: Connection, portfolio: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(portfolio);
  if (!info) throw new Error(`portfolio ${portfolio.toBase58()} not found`);
  return decodePortfolioSummary(
    new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength),
  ).capital;
}

interface Market {
  market: PublicKey;
  vaultPda: PublicKey;
  housePda: PublicKey;
  userPf: PublicKey;
}

// Build a fresh market: vault + funded House + active asset 0 + a funded user portfolio.
async function setupMarket(
  conn: Connection,
  payer: Keypair,
  quoteMint: PublicKey,
  payerAta: PublicKey,
  depositAmount: bigint,
): Promise<Market> {
  const market = Keypair.generate();
  const space = marketAccountSize(CAP);
  const rent = await conn.getMinimumBalanceForRentExemption(space);
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  await send(
    conn,
    new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: market.publicKey,
          lamports: rent,
          space,
          programId: PROGRAM_ID,
        }),
      )
      .add(
        initMarketIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          quoteMint,
          marketGroupId: randomBytes(32),
          assetSlotCapacity: CAP,
          vaultBump,
          baseMint: PublicKey.default,
          oracleKind: ORACLE_KIND_MANUAL,
          oracleFeedId: new Uint8Array(32),
          oraclePool: PublicKey.default,
        }),
      )
      .add(
        createVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          vault: vaultPda,
          quoteMint,
        }),
      )
      .add(
        createHouseVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          housePortfolio: housePda,
          houseBump,
        }),
      ),
    [payer, market],
    "InitMarket + CreateVault + CreateHouseVault",
  );
  await send(
    conn,
    new Transaction()
      .add(
        fundHouseVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          housePortfolio: housePda,
          authority: payer.publicKey,
          authorityToken: payerAta,
          vaultToken: vaultPda,
          amount: HOUSE_FUND,
        }),
      )
      .add(
        activateMarketIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          assetIndex: 0,
          authenticatedPrice: PRICE,
        }),
      ),
    [payer],
    "FundHouseVault + ActivateMarket",
  );
  const [userPf, userBump] = portfolioPda(
    PROGRAM_ID,
    payer.publicKey,
    market.publicKey,
  );
  await send(
    conn,
    new Transaction()
      .add(
        initPortfolioIx({
          programId: PROGRAM_ID,
          portfolio: userPf,
          market: market.publicKey,
          owner: payer.publicKey,
          bump: userBump,
        }),
      )
      .add(
        depositIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          portfolio: userPf,
          owner: payer.publicKey,
          vaultToken: vaultPda,
          userToken: payerAta,
          amount: depositAmount,
        }),
      ),
    [payer],
    `InitPortfolio + Deposit(${depositAmount / UNIT})`,
  );
  return { market: market.publicKey, vaultPda, housePda, userPf };
}

async function setSpread(
  conn: Connection,
  payer: Keypair,
  m: Market,
  impactK: bigint,
  skewK: bigint,
  oiMult: bigint,
): Promise<void> {
  const [pda, bump] = riskConfigPda(PROGRAM_ID, m.market);
  await send(
    conn,
    new Transaction().add(
      setRiskConfigIx({
        programId: PROGRAM_ID,
        riskConfigPda: pda,
        market: m.market,
        authority: payer.publicKey,
        oiMultiplierBps: oiMult,
        maxBasePositionPerWallet: 0n,
        maxStalenessPauseSlots: 0n,
        impactKBps: impactK,
        skewKBps: skewK,
        maxSpreadBps: MAX_SPREAD,
        bump,
      }),
    ),
    [payer],
    `SetRiskConfig(impactK=${impactK}, skewK=${skewK}, oiMult=${oiMult})`,
  );
}

// One long trade of `size`; returns the fee charged to the user (capital drop).
async function tradeFee(
  conn: Connection,
  payer: Keypair,
  m: Market,
  size: bigint,
): Promise<bigint> {
  const before = await capital(conn, m.userPf);
  await send(
    conn,
    new Transaction().add(
      placeOrderIx({
        programId: PROGRAM_ID,
        market: m.market,
        userPortfolio: m.userPf,
        housePortfolio: m.housePda,
        user: payer.publicKey,
        side: Side.Long,
        assetIndex: 0,
        sizeQ: size,
        execPrice: PRICE,
        feeBps: FEE,
      }),
    ),
    [payer],
    `PlaceOrder(long ${size})`,
  );
  const after = await capital(conn, m.userPf);
  return before - after;
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(
    `rpc=${RPC}\nprogram=${PROGRAM_ID.toBase58()}\npayer=${payer.publicKey.toBase58()}`,
  );
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error("program not deployed/executable");

  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(
    conn,
    payer,
    quoteMint,
    payer.publicKey,
  );
  await mintTo(conn, payer, quoteMint, payerAta, payer, 500n * UNIT);

  // Part 1: impact differential between two identical fresh markets.
  section("impact spread: OFF baseline");
  const off = await setupMarket(conn, payer, quoteMint, payerAta, 10n * UNIT);
  const feeOff = await tradeFee(conn, payer, off, LONG);
  console.log(`  feeOff = ${feeOff} atoms`);

  section("impact spread: ON");
  const on = await setupMarket(conn, payer, quoteMint, payerAta, 10n * UNIT);
  await setSpread(conn, payer, on, IMPACT_K, 0n, 0n);
  const feeOn = await tradeFee(conn, payer, on, LONG);
  console.log(`  feeOn  = ${feeOn} atoms`);

  check(feeOn > feeOff, "spread-on charges strictly more fee than spread-off");
  check(
    feeOn - feeOff === EXPECTED_IMPACT_FEE,
    `extra fee == predicted impact (${EXPECTED_IMPACT_FEE} atoms = 40 bps on 20 mUSDC)`,
  );

  // Part 2: skew surcharge on a pile-on into the crowded side. First trade leaves the
  // House flat (no skew); the second piles on (House already short), so it pays skew.
  section("skew spread: pile-on pays more than the first trade");
  const sk = await setupMarket(conn, payer, quoteMint, payerAta, 30n * UNIT);
  await setSpread(conn, payer, sk, 0n, 500n, 100_000n);
  const d1 = await tradeFee(conn, payer, sk, LONG); // House flat before -> skew 0
  const d2 = await tradeFee(conn, payer, sk, LONG); // House short before -> skew > 0
  console.log(`  firstTradeFee = ${d1} atoms, pileOnFee = ${d2} atoms`);
  check(d2 > d1, "a risk-increasing pile-on pays a skew surcharge the first trade did not");

  console.log(`\nALL SPREAD CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
