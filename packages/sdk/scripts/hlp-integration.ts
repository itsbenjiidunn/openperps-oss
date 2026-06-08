// Integration test for the House-LP (HLP) instructions, against a deployed program
// that includes them (rebuild + redeploy first; the old devnet program predates HLP).
//
// Run (PowerShell), with a funded devnet keypair and the HLP-enabled program id:
//   $env:OPENPERPS_PROGRAM_ID="<your HLP-enabled program id>"
//   $env:OPENPERPS_PAYER="C:\tmp\op-devnet\id.json"
//   node --import tsx packages/sdk/scripts/hlp-integration.ts
//
// It proves, on real accounts, that the HLP handlers work end-to-end (the part host
// tests cannot cover: SPL token CPI, PDA creation, on-chain share/balance persistence):
//   - Deposit mints shares and lands quote in the buffer.
//   - Deploy moves buffer into the engine House (NAV conserved).
//   - Redeem is priced at NAV, paid from the buffer, and bounded by it
//     (HlpBufferInsufficient once the buffer is drained into the House).
//   - Harvest pulls House capital back to the buffer (the House is flat here), then
//     the queued redemption goes through.

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
  createHlpVaultIx,
  setHlpParamsIx,
  depositHlpIx,
  deployHlpIx,
  requestRedeemHlpIx,
  executeRedeemHlpIx,
  harvestHlpIx,
  hlpConfigPda,
  hlpVaultPda,
  hlpPositionPda,
  marketAccountSize,
  readU128LE,
  OFFSET_CAPITAL,
  OFFSET_HLP_TOTAL_SHARES,
  OFFSET_HLP_POSITION_SHARES,
  VAULT_SEED,
  HOUSE_SEED,
  ORACLE_KIND_MANUAL,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey(
  process.env.OPENPERPS_PROGRAM_ID ??
    "2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4",
);
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH =
  process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 1;
const UNIT = 1_000_000n; // 1 mUSDC (6 dp)

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

  // Setup: mint, market + vault + House, HLP buffer + config (fee 0, delay 0,
  // haircut 0 for clean accounting).
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
      ),
    [payer, market],
    "InitMarket + CreateVault",
  );

  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [hlpVault] = hlpVaultPda(PROGRAM_ID, market.publicKey);
  const [cfgPda, cfgBump] = hlpConfigPda(PROGRAM_ID, market.publicKey);
  const [position, positionBump] = hlpPositionPda(
    PROGRAM_ID,
    market.publicKey,
    payer.publicKey,
  );
  await send(
    conn,
    new Transaction()
      .add(
        createHouseVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          housePortfolio: housePda,
          houseBump,
        }),
      )
      .add(
        createHlpVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          vault: hlpVault,
          quoteMint,
        }),
      )
      .add(
        setHlpParamsIx({
          programId: PROGRAM_ID,
          cfgPda,
          market: market.publicKey,
          authority: payer.publicKey,
          redeemDelaySlots: 0n,
          feeBps: 0n,
          minDeposit: 1_000n,
          navHaircutBps: 0n,
          bump: cfgBump,
        }),
      ),
    [payer],
    "CreateHouseVault + CreateHlpVault + SetHlpParams",
  );

  const deposit = (amount: bigint) =>
    depositHlpIx({
      programId: PROGRAM_ID,
      cfgPda,
      market: market.publicKey,
      depositor: payer.publicKey,
      depositorToken: payerAta,
      vault: hlpVault,
      position,
      housePortfolio: housePda,
      amount,
      positionBump,
    });
  const executeRedeem = () =>
    executeRedeemHlpIx({
      programId: PROGRAM_ID,
      cfgPda,
      market: market.publicKey,
      owner: payer.publicKey,
      ownerToken: payerAta,
      vault: hlpVault,
      position,
      housePortfolio: housePda,
      positionBump,
    });
  const requestRedeem = (shares: bigint) =>
    requestRedeemHlpIx({
      programId: PROGRAM_ID,
      cfgPda,
      market: market.publicKey,
      owner: payer.publicKey,
      position,
      shares,
      positionBump,
    });

  // Deposit twice (2 mUSDC into the buffer).
  section("deposit");
  await send(conn, new Transaction().add(deposit(UNIT)), [payer], "DepositHlp #1");
  check((await tokenBal(conn, hlpVault)) === UNIT, "buffer holds the first deposit");
  check(
    (await u128At(conn, cfgPda, OFFSET_HLP_TOTAL_SHARES)) > 0n,
    "shares minted",
  );
  check(
    (await u128At(conn, position, OFFSET_HLP_POSITION_SHARES)) > 0n,
    "LP position has shares",
  );

  await send(conn, new Transaction().add(deposit(UNIT)), [payer], "DepositHlp #2");
  check((await tokenBal(conn, hlpVault)) === 2n * UNIT, "buffer holds both deposits");
  const totalShares = await u128At(conn, cfgPda, OFFSET_HLP_TOTAL_SHARES);
  const lpShares = await u128At(conn, position, OFFSET_HLP_POSITION_SHARES);
  check(lpShares === totalShares, "the only LP owns all shares");

  // Deploy half into the engine House. NAV is conserved (buffer down, House up).
  section("deploy");
  await send(
    conn,
    new Transaction().add(
      deployHlpIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        housePortfolio: housePda,
        vault: hlpVault,
        marketVault: vaultPda,
        authority: payer.publicKey,
        amount: UNIT,
      }),
    ),
    [payer],
    "DeployHlp(1 mUSDC)",
  );
  check(
    (await tokenBal(conn, hlpVault)) === UNIT,
    "buffer drops by the deployed amount",
  );
  check(
    (await u128At(conn, housePda, OFFSET_CAPITAL)) === UNIT,
    "House capital rose by the deployed amount",
  );

  // Redeem half the shares: NAV is 2 mUSDC, half = 1 mUSDC, exactly the free buffer.
  section("redeem (bounded by buffer)");
  const half = lpShares / 2n;
  const before = await tokenBal(conn, payerAta);
  await send(
    conn,
    new Transaction().add(requestRedeem(half)),
    [payer],
    "RequestRedeemHlp(half)",
  );
  await send(
    conn,
    new Transaction().add(executeRedeem()),
    [payer],
    "ExecuteRedeemHlp(half)",
  );
  check(
    (await tokenBal(conn, payerAta)) - before === UNIT,
    "redeemer received ~half of NAV",
  );
  check(
    (await tokenBal(conn, hlpVault)) === 0n,
    "buffer drained to pay the redemption",
  );

  // The remaining value is locked in the House; redeeming it now exceeds the buffer.
  section("buffer bound + harvest");
  const remaining = await u128At(conn, position, OFFSET_HLP_POSITION_SHARES);
  await send(
    conn,
    new Transaction().add(requestRedeem(remaining)),
    [payer],
    "RequestRedeemHlp(remaining)",
  );
  await expectFail(
    () =>
      sendAndConfirmTransaction(
        conn,
        new Transaction().add(executeRedeem()),
        [payer],
        { commitment: "confirmed" },
      ),
    "ExecuteRedeemHlp rejected while the buffer is empty",
  );

  // Harvest the House back into the buffer (the House is flat: no trades), then the
  // queued redemption clears.
  await send(
    conn,
    new Transaction().add(
      harvestHlpIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        housePortfolio: housePda,
        marketVault: vaultPda,
        vault: hlpVault,
        authority: payer.publicKey,
        amount: UNIT,
      }),
    ),
    [payer],
    "HarvestHlp(1 mUSDC)",
  );
  check(
    (await tokenBal(conn, hlpVault)) === UNIT,
    "buffer refilled by the harvest",
  );
  const before2 = await tokenBal(conn, payerAta);
  await send(
    conn,
    new Transaction().add(executeRedeem()),
    [payer],
    "ExecuteRedeemHlp(remaining) after harvest",
  );
  check(
    (await tokenBal(conn, payerAta)) - before2 === UNIT,
    "redeemer received the rest",
  );
  check(
    (await u128At(conn, position, OFFSET_HLP_POSITION_SHARES)) === 0n,
    "LP fully redeemed",
  );

  console.log(`\nALL HLP CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
