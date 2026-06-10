// On-chain integration test for the core trade lifecycle and its guards, against a
// deployed program. Part of the on-chain suite (see scripts/run-onchain-suite.sh).
//
// Run (PowerShell), with a funded keypair + the deployed program id:
//   $env:OPENPERPS_PROGRAM_ID="<program id>"
//   $env:OPENPERPS_RPC="http://127.0.0.1:8899"
//   $env:OPENPERPS_PAYER="<keypair path>"
//   node --import tsx packages/sdk/scripts/core-integration.ts
//
// Proves on real accounts (what host tests cannot: SPL CPI, PDA creation, runtime
// account contract):
//   - the full setup + a PlaceOrder crosses the user vs the House (user gets the
//     position, House the opposite side),
//   - Withdraw is refused while the user holds an open position,
//   - SetHouseCap is enforced: a trade that would push the House's net position past
//     the cap reverts.

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
  withdrawIx,
  placeOrderIx,
  setHouseCapIx,
  houseCapPda,
  portfolioPda,
  marketAccountSize,
  decodePortfolioPositions,
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
async function positions(conn: Connection, portfolio: PublicKey) {
  const info = await conn.getAccountInfo(portfolio);
  if (!info) return [];
  return decodePortfolioPositions(
    new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength),
  );
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(
    `rpc=${RPC}\nprogram=${PROGRAM_ID.toBase58()}\npayer=${payer.publicKey.toBase58()}`,
  );
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error("program not deployed/executable");

  section("setup");
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(
    conn,
    payer,
    quoteMint,
    payer.publicKey,
  );
  await mintTo(conn, payer, quoteMint, payerAta, payer, 200n * UNIT);

  const market = Keypair.generate();
  const size = marketAccountSize(CAP);
  const rent = await conn.getMinimumBalanceForRentExemption(size);
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
          amount: 50n * UNIT,
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
    "FundHouseVault(50) + ActivateMarket",
  );

  // User = payer; init the user portfolio + deposit collateral.
  const [userPf, userBump] = portfolioPda(PROGRAM_ID, payer.publicKey, market.publicKey);
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
          amount: 10n * UNIT,
        }),
      ),
    [payer],
    "InitPortfolio + Deposit(10)",
  );

  // The trade: user goes long ~2x (notional 20, IM 2 < 10 capital) against the House.
  section("trade crosses user vs House");
  const longSize = 200_000n; // notional = size * price / 1e6 = 20 mUSDC
  await send(
    conn,
    new Transaction().add(
      placeOrderIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        userPortfolio: userPf,
        housePortfolio: housePda,
        user: payer.publicKey,
        side: Side.Long,
        assetIndex: 0,
        sizeQ: longSize,
        execPrice: PRICE,
        feeBps: 10n,
      }),
    ),
    [payer],
    "PlaceOrder(long 200k)",
  );
  const userPos = await positions(conn, userPf);
  const housePos = await positions(conn, housePda);
  check(
    userPos.some((p) => p.assetIndex === 0 && p.side === Side.Long),
    "user holds the long position",
  );
  check(
    housePos.some((p) => p.assetIndex === 0 && p.side === Side.Short),
    "House holds the opposite short",
  );

  // Withdraw is refused while the user has an open leg.
  section("guards");
  await expectFail(
    () =>
      sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          withdrawIx({
            programId: PROGRAM_ID,
            market: market.publicKey,
            portfolio: userPf,
            owner: payer.publicKey,
            vaultToken: vaultPda,
            userToken: payerAta,
            amount: UNIT,
          }),
        ),
        [payer],
        { commitment: "confirmed" },
      ),
    "Withdraw refused while a position is open",
  );

  // SetHouseCap to 300k; the House is at 200k, so a trade pushing it to 400k reverts.
  const [hcPda, hcBump] = houseCapPda(PROGRAM_ID, market.publicKey);
  await send(
    conn,
    new Transaction().add(
      setHouseCapIx({
        programId: PROGRAM_ID,
        houseCapPda: hcPda,
        market: market.publicKey,
        authority: payer.publicKey,
        maxBasePosition: 300_000n,
        bump: hcBump,
      }),
    ),
    [payer],
    "SetHouseCap(300k)",
  );
  await expectFail(
    () =>
      sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          placeOrderIx({
            programId: PROGRAM_ID,
            market: market.publicKey,
            userPortfolio: userPf,
            housePortfolio: housePda,
            user: payer.publicKey,
            side: Side.Long,
            assetIndex: 0,
            sizeQ: 200_000n, // House short -> 400k > 300k cap
            execPrice: PRICE,
            feeBps: 10n,
          }),
        ),
        [payer],
        { commitment: "confirmed" },
      ),
    "PlaceOrder past the House cap reverts",
  );

  console.log(`\nALL CORE CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
