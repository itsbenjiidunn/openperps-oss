// Integration test for the Insurance-LP (InsLP) instructions, against a deployed
// program that includes them (rebuild + redeploy first).
//
// Proves, on real accounts, that the InsLP handlers work end-to-end (the part host
// tests cannot cover: SPL token CPI, PDA creation, the engine insurance interaction,
// on-chain share/balance persistence):
//   - Deposit raises the engine insurance `I`, lands quote in the market vault, and
//     mints shares priced at NAV (= total `I`).
//   - Redeem is priced at NAV, paid from the market vault, and respects the insurance
//     floor (InsuranceFloorBreach when a redemption would pull `I` below it).
//   - A floor-respecting redemption goes through and returns ~the deposit.

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
  activateMarketIx,
  setInsLpParamsIx,
  depositInsLpIx,
  requestRedeemInsLpIx,
  executeRedeemInsLpIx,
  setInsuranceParamsIx,
  insLpConfigPda,
  insLpPositionPda,
  insuranceCfgPda,
  marketAccountSize,
  readU128LE,
  OFFSET_HLP_TOTAL_SHARES,
  OFFSET_HLP_POSITION_SHARES,
  VAULT_SEED,
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
const UNIT = 1_000_000n; // 1 mUSDC (6 dp)
const PRICE = 100_000_000n; // activation mark (PRICE_SCALE units); the insurance domain
// (asset 0, long) only becomes valid once the asset slot is activated.

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
async function expectFail(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch {
    passes++;
    console.log(`  PASS  ${label} (reverted as expected)`);
    return;
  }
  throw new Error(`ASSERT FAILED: ${label} (expected revert)`);
}
async function tokenBal(conn: Connection, acct: PublicKey): Promise<bigint> {
  return BigInt((await conn.getTokenAccountBalance(acct)).value.amount);
}
async function u128At(
  conn: Connection,
  acct: PublicKey,
  off: number,
): Promise<bigint> {
  const info = await conn.getAccountInfo(acct);
  if (!info) throw new Error(`account ${acct.toBase58()} not found`);
  return readU128LE(info.data, off);
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(
    `rpc=${RPC}\nprogram=${PROGRAM_ID.toBase58()}\npayer=${payer.publicKey.toBase58()}`,
  );
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error("program not deployed/executable");

  // Setup: mint, market + vault, InsLP config (fee 0, delay 0 for clean accounting).
  section("setup");
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(
    conn,
    payer,
    quoteMint,
    payer.publicKey,
  );
  await mintTo(conn, payer, quoteMint, payerAta, payer, 100n * UNIT);

  const market = Keypair.generate();
  const size = marketAccountSize(CAP);
  const rent = await conn.getMinimumBalanceForRentExemption(size);
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
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
          space: size,
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
        activateMarketIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          assetIndex: 0,
          authenticatedPrice: PRICE,
        }),
      ),
    [payer, market],
    "InitMarket + CreateVault + ActivateMarket",
  );

  const [cfgPda, cfgBump] = insLpConfigPda(PROGRAM_ID, market.publicKey);
  const [position, positionBump] = insLpPositionPda(
    PROGRAM_ID,
    market.publicKey,
    payer.publicKey,
  );
  const [insCfg, insCfgBump] = insuranceCfgPda(PROGRAM_ID, market.publicKey);
  await send(
    conn,
    new Transaction().add(
      setInsLpParamsIx({
        programId: PROGRAM_ID,
        cfgPda,
        market: market.publicKey,
        authority: payer.publicKey,
        redeemDelaySlots: 0n,
        feeBps: 0n,
        minDeposit: 1_000n,
        bump: cfgBump,
      }),
    ),
    [payer],
    "SetInsLpParams",
  );

  // Deposit 2 mUSDC into the insurance fund: raises `I`, lands quote in the vault,
  // mints shares. NAV before the first deposit is 0; the virtual offset makes the
  // first depositor's shares claim ~their own deposit.
  section("deposit");
  await send(
    conn,
    new Transaction().add(
      depositInsLpIx({
        programId: PROGRAM_ID,
        cfgPda,
        market: market.publicKey,
        depositor: payer.publicKey,
        depositorToken: payerAta,
        marketVault: vaultPda,
        position,
        amount: 2n * UNIT,
        positionBump,
      }),
    ),
    [payer],
    "DepositInsLp(2 mUSDC)",
  );
  check((await tokenBal(conn, vaultPda)) === 2n * UNIT, "market vault holds the insurance deposit");
  const totalShares = await u128At(conn, cfgPda, OFFSET_HLP_TOTAL_SHARES);
  const lpShares = await u128At(conn, position, OFFSET_HLP_POSITION_SHARES);
  check(totalShares > 0n, "shares minted");
  check(lpShares === totalShares, "the only LP owns all shares");

  // Set an insurance floor of 1 mUSDC: a redemption can never pull `I` below it.
  section("floor");
  await send(
    conn,
    new Transaction().add(
      setInsuranceParamsIx({
        programId: PROGRAM_ID,
        cfgPda: insCfg,
        market: market.publicKey,
        authority: payer.publicKey,
        minBalance: UNIT,
        withdrawDelaySlots: 0n,
        bump: insCfgBump,
      }),
    ),
    [payer],
    "SetInsuranceParams(floor = 1 mUSDC)",
  );

  // Redeeming ALL shares would drain `I` to ~0, below the floor -> rejected.
  await send(
    conn,
    new Transaction().add(
      requestRedeemInsLpIx({
        programId: PROGRAM_ID,
        cfgPda,
        market: market.publicKey,
        owner: payer.publicKey,
        position,
        shares: lpShares,
        positionBump,
      }),
    ),
    [payer],
    "RequestRedeemInsLp(all)",
  );
  const exec = () =>
    executeRedeemInsLpIx({
      programId: PROGRAM_ID,
      cfgPda,
      market: market.publicKey,
      owner: payer.publicKey,
      ownerToken: payerAta,
      marketVault: vaultPda,
      position,
      insuranceCfg: insCfg,
      positionBump,
    });
  await expectFail(
    () =>
      sendAndConfirmTransaction(conn, new Transaction().add(exec()), [payer], {
        commitment: "confirmed",
      }),
    "ExecuteRedeemInsLp(all) rejected by the insurance floor",
  );

  // Redeem HALF: leaves `I` at the 1 mUSDC floor, so it goes through and pays ~1 mUSDC.
  section("redeem (floor-respecting)");
  const half = lpShares / 2n;
  await send(
    conn,
    new Transaction().add(
      requestRedeemInsLpIx({
        programId: PROGRAM_ID,
        cfgPda,
        market: market.publicKey,
        owner: payer.publicKey,
        position,
        shares: half,
        positionBump,
      }),
    ),
    [payer],
    "RequestRedeemInsLp(half)",
  );
  const before = await tokenBal(conn, payerAta);
  await send(conn, new Transaction().add(exec()), [payer], "ExecuteRedeemInsLp(half)");
  check((await tokenBal(conn, payerAta)) - before === UNIT, "redeemer received ~half of NAV");
  check((await tokenBal(conn, vaultPda)) === UNIT, "market vault left at the floor");
  check(
    (await u128At(conn, position, OFFSET_HLP_POSITION_SHARES)) === lpShares - half,
    "half the LP shares remain",
  );

  console.log(`\nALL INSLP CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
