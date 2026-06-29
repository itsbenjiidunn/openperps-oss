// On-chain integration test for the House withdrawal timelock (SetHouseLock), against a
// deployed program. Part of the on-chain suite.
//
// Proves on real accounts that a market authority can rug-proof a House seed:
//   - with a future unlock_slot committed, WithdrawHouseVault is REFUSED (HouseLocked),
//     even though the House is flat (no positions),
//   - the unlock_slot is RAISE-ONLY: a later SetHouseLock with a lower slot reverts, a
//     higher one succeeds,
//   - a market whose lock has already passed (unlock_slot in the past) can withdraw.

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
import { createMint, createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  initMarketIx,
  createVaultIx,
  createHouseVaultIx,
  fundHouseVaultIx,
  setHouseLockIx,
  houseLockPda,
  withdrawHouseVaultIx,
  marketAccountSize,
  VAULT_SEED,
  HOUSE_SEED,
  ORACLE_KIND_MANUAL,
  DEVNET_PROGRAM_ID,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey(process.env.OPENPERPS_PROGRAM_ID ?? DEVNET_PROGRAM_ID);
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 1;
const UNIT = 1_000_000n;
const FUND = 50n * UNIT;

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
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}
async function send(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<void> {
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label} tx=${sig}`);
}
async function expectFail(fn: () => Promise<unknown>, label: string): Promise<void> {
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

interface Mkt {
  market: PublicKey;
  vaultPda: PublicKey;
  housePda: PublicKey;
}

async function fundedMarket(conn: Connection, payer: Keypair, quoteMint: PublicKey, payerAta: PublicKey): Promise<Mkt> {
  const market = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(marketAccountSize(CAP));
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync([VAULT_SEED, market.publicKey.toBuffer()], PROGRAM_ID);
  const [housePda, houseBump] = PublicKey.findProgramAddressSync([HOUSE_SEED, market.publicKey.toBuffer()], PROGRAM_ID);
  await send(
    conn,
    new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: market.publicKey,
          lamports: rent,
          space: marketAccountSize(CAP),
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
      .add(createVaultIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, vault: vaultPda, quoteMint }))
      .add(createHouseVaultIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, housePortfolio: housePda, houseBump })),
    [payer, market],
    "InitMarket + CreateVault + CreateHouseVault",
  );
  await send(
    conn,
    new Transaction().add(
      fundHouseVaultIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        housePortfolio: housePda,
        authority: payer.publicKey,
        authorityToken: payerAta,
        vaultToken: vaultPda,
        amount: FUND,
      }),
    ),
    [payer],
    "FundHouseVault(50)",
  );
  return { market: market.publicKey, vaultPda, housePda };
}

function lock(conn: Connection, payer: Keypair, m: Mkt, unlockSlot: bigint): Transaction {
  const [pda, bump] = houseLockPda(PROGRAM_ID, m.market);
  return new Transaction().add(
    setHouseLockIx({ programId: PROGRAM_ID, houseLockPda: pda, market: m.market, authority: payer.publicKey, unlockSlot, bump }),
  );
}
function withdraw(payer: Keypair, m: Mkt, payerAta: PublicKey): Transaction {
  return new Transaction().add(
    withdrawHouseVaultIx({
      programId: PROGRAM_ID,
      market: m.market,
      housePortfolio: m.housePda,
      authority: payer.publicKey,
      vaultToken: m.vaultPda,
      authorityToken: payerAta,
      amount: UNIT,
    }),
  );
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}\nprogram=${PROGRAM_ID.toBase58()}\npayer=${payer.publicKey.toBase58()}`);
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error("program not deployed/executable");

  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
  await mintTo(conn, payer, quoteMint, payerAta, payer, 500n * UNIT);

  // Committed (future) lock: withdrawal refused + raise-only ratchet.
  section("a committed House lock blocks withdrawal (rug-proof) and is raise-only");
  const a = await fundedMarket(conn, payer, quoteMint, payerAta);
  const now = BigInt(await conn.getSlot());
  await send(conn, lock(conn, payer, a, now + 1_000_000n), [payer], "SetHouseLock(now + 1_000_000)");
  await expectFail(
    () => sendAndConfirmTransaction(conn, withdraw(payer, a, payerAta), [payer], { commitment: "confirmed" }),
    "WithdrawHouseVault refused while the House is locked (House is flat)",
  );
  await expectFail(
    () => sendAndConfirmTransaction(conn, lock(conn, payer, a, now + 500_000n), [payer], { commitment: "confirmed" }),
    "SetHouseLock to an EARLIER slot rejected (raise-only ratchet)",
  );
  await send(conn, lock(conn, payer, a, now + 2_000_000n), [payer], "SetHouseLock to a LATER slot (raise allowed)");

  // A market whose lock has already passed can withdraw.
  section("an expired lock allows withdrawal");
  const b = await fundedMarket(conn, payer, quoteMint, payerAta);
  await send(conn, lock(conn, payer, b, 1n), [payer], "SetHouseLock(slot 1, already passed)");
  const before = await tokenBal(conn, payerAta);
  await send(conn, withdraw(payer, b, payerAta), [payer], "WithdrawHouseVault(1)");
  check((await tokenBal(conn, payerAta)) - before === UNIT, "withdrawal of 1 mUSDC went through once the lock passed");

  console.log(`\nALL TIMELOCK CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
