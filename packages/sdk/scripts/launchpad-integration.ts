// On-chain integration test for the OPP Launchpad primitive (buildLaunchpadPerp),
// against a deployed program. Part of the on-chain suite.
//
// Proves on real accounts that launching a perp on a freshly created token, seeded by
// the creator allocation, yields a safe coin-margin market:
//   - one buildLaunchpadPerp call creates the market, vault, House, funds the House with
//     the allocation, activates at the launch price, and sets the safe risk profile,
//   - the market is coin-margin (quote == base) and the House holds the allocation,
//   - the program forced the VOLATILE 5x tier: a >5x trade is REJECTED, a <=5x trade is
//     ACCEPTED, so the freshly launched, reflexive market is capped at 5x out of the box.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  buildLaunchpadPerp,
  isCoinMargin,
  initPortfolioIx,
  depositIx,
  placeOrderIx,
  portfolioPda,
  marketAccountSize,
  decodePortfolioPositions,
  Side,
  VAULT_SEED,
  HOUSE_SEED,
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
const LAUNCH_PRICE_USD = 100; // -> priceInt 100e6 (mark)
const ALLOCATION = 100n * UNIT; // creator allocation seeded into the House (token atoms)
const DEPOSIT = 12n * UNIT; // trader collateral (the same token)
// notional = size * 100e6 / 1e6. REJECT 800k -> 80e6 (20% im = 16 > 12). ACCEPT 500k ->
// 50e6 (20% im = 10 < 12). At the 10x STABLE tier both would pass, so a reject proves 5x.
const REJECT_SIZE = 800_000n;
const ACCEPT_SIZE = 500_000n;

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
async function tokenBal(conn: Connection, acct: PublicKey): Promise<bigint> {
  return BigInt((await conn.getTokenAccountBalance(acct)).value.amount);
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

  // The "freshly launched" token. The payer is the creator: it holds the whole supply.
  section("mint the launched token");
  const token = await createMint(conn, payer, payer.publicKey, null, 6);
  const tokenAta = await createAssociatedTokenAccount(conn, payer, token, payer.publicKey);
  await mintTo(conn, payer, token, tokenAta, payer, 1_000n * UNIT);

  // One launch: coin-margin perp on the token, seeded by the allocation.
  section("launch: buildLaunchpadPerp (token + perp, seeded by allocation)");
  check(isCoinMargin(token, token), "SDK isCoinMargin true for the launched token");
  const market = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(marketAccountSize(CAP));
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [housePda] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const listing = buildLaunchpadPerp({
    programId: PROGRAM_ID,
    authority: payer.publicKey,
    market: market.publicKey,
    marketRentLamports: rent,
    token,
    symbol: "LAUNCH",
    launchPriceUsd: LAUNCH_PRICE_USD,
    allocationAtoms: ALLOCATION,
    authorityTokenAccount: tokenAta,
  });
  // The build is one ordered instruction list. Account creation (the only step that
  // needs the market keypair signature) is first; send it with the market signer, then
  // the rest in small chunks under the tx size limit.
  const ix = listing.instructions;
  await send(conn, new Transaction().add(...ix.slice(0, 2)), [payer, market], "create market + init");
  for (let i = 2; i < ix.length; i += 3) {
    await send(conn, new Transaction().add(...ix.slice(i, i + 3)), [payer], `launch setup [${i}]`);
  }
  check((await tokenBal(conn, vaultPda)) === ALLOCATION, "House seeded with the full allocation");

  // The launched market enforces the coin-margin 5x tier.
  section("the launched market is capped at 5x");
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
          userToken: tokenAta,
          amount: DEPOSIT,
        }),
      ),
    [payer],
    "InitPortfolio + Deposit(12)",
  );
  const order = (size: bigint) =>
    new Transaction().add(
      placeOrderIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        userPortfolio: userPf,
        housePortfolio: housePda,
        user: payer.publicKey,
        side: Side.Long,
        assetIndex: 0,
        sizeQ: size,
        execPrice: 100_000_000n,
        feeBps: 10n,
      }),
    );
  try {
    await sendAndConfirmTransaction(conn, order(REJECT_SIZE), [payer], { commitment: "confirmed" });
    throw new Error("ASSERT FAILED: a >5x trade should have reverted on the launched market");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("ASSERT FAILED")) throw e;
    passes++;
    console.log("  PASS  >5x trade rejected (20% initial margin enforced) (reverted as expected)");
  }
  await send(conn, order(ACCEPT_SIZE), [payer], "PlaceOrder(within 5x)");
  check(
    (await positions(conn, userPf)).some((p) => p.assetIndex === 0 && p.side === Side.Long),
    "a <=5x trade is accepted: the launched market is live and tradeable at 5x",
  );

  console.log(`\nALL LAUNCHPAD CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
