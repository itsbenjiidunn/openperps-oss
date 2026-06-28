// On-chain integration test for coin-margin (token-collateralized) markets, against a
// deployed program. Part of the on-chain suite (see scripts/run-onchain-suite.sh).
//
// Proves on real accounts that a coin-margin market (quote_mint == base_mint) is forced
// to the tighter VOLATILE risk tier (5x, 20% initial margin), while a USDC-style market
// (quote_mint != base_mint) keeps the looser STABLE tier (10x, 10% initial margin):
//   - The SAME discriminating trade (notional needing >10% but <=20% margin) is
//     REJECTED on the coin-margin market and ACCEPTED on the USDC market.
//   - A within-5x trade is accepted on the coin-margin market (it is not just rejecting
//     everything; it enforces exactly the 5x bound).
//   - The SDK `isCoinMargin` helper mirrors the on-chain detection.

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
  portfolioPda,
  marketAccountSize,
  decodePortfolioPositions,
  isCoinMargin,
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
const PRICE = 100_000_000n; // mark at the 1e6 price scale
const HOUSE_FUND = 100n * UNIT;
const DEPOSIT = 12n * UNIT; // 12 tokens capital
// notional = size * PRICE / 1e6.
//   REJECT: size 800_000 -> notional 80e6. coin-margin im 20% = 16e6 > 12e6 (reject);
//           USDC im 10% = 8e6 < 12e6 (accept).
//   ACCEPT: size 500_000 -> notional 50e6. coin-margin im 20% = 10e6 < 12e6 (accept).
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

interface Market {
  market: PublicKey;
  vaultPda: PublicKey;
  housePda: PublicKey;
  userPf: PublicKey;
}

// Build a market with explicit quote/base mints, a funded House, and a funded user.
// `quoteAta` is the payer's token account of `quoteMint` (the collateral).
async function setupMarket(
  conn: Connection,
  payer: Keypair,
  quoteMint: PublicKey,
  baseMint: PublicKey,
  quoteAta: PublicKey,
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
          baseMint,
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
          authorityToken: quoteAta,
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
          userToken: quoteAta,
          amount: DEPOSIT,
        }),
      ),
    [payer],
    "InitPortfolio + Deposit(12)",
  );
  return { market: market.publicKey, vaultPda, housePda, userPf };
}

function order(m: Market, payer: Keypair, size: bigint): Transaction {
  return new Transaction().add(
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
      feeBps: 10n,
    }),
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

  section("mints");
  // T = the perped token (collateral for the coin-margin market); U = a USDC stand-in.
  const tokenMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const usdcMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const tokenAta = await createAssociatedTokenAccount(conn, payer, tokenMint, payer.publicKey);
  const usdcAta = await createAssociatedTokenAccount(conn, payer, usdcMint, payer.publicKey);
  await mintTo(conn, payer, tokenMint, tokenAta, payer, 1_000n * UNIT);
  await mintTo(conn, payer, usdcMint, usdcAta, payer, 1_000n * UNIT);

  // Coin-margin: quote_mint == base_mint == the token.
  section("coin-margin market (quote == base): tighter VOLATILE tier (5x)");
  check(isCoinMargin(tokenMint, tokenMint), "SDK isCoinMargin true when quote == base");
  const cm = await setupMarket(conn, payer, tokenMint, tokenMint, tokenAta);
  await expectFail(
    () => sendAndConfirmTransaction(conn, order(cm, payer, REJECT_SIZE), [payer], { commitment: "confirmed" }),
    "coin-margin rejects a >5x trade (20% initial margin enforced: 80e6 notional needs 16 > 12 capital)",
  );
  await send(conn, order(cm, payer, ACCEPT_SIZE), [payer], "PlaceOrder(within 5x)");
  check(
    (await positions(conn, cm.userPf)).some((p) => p.assetIndex === 0 && p.side === Side.Long),
    "coin-margin accepts a <=5x trade (50e6 notional needs 10 < 12 capital)",
  );

  // USDC-style: quote_mint = USDC, base_mint = the token (quote != base).
  section("USDC-style market (quote != base): looser STABLE tier (10x)");
  check(!isCoinMargin(usdcMint, tokenMint), "SDK isCoinMargin false when quote != base");
  const lin = await setupMarket(conn, payer, usdcMint, tokenMint, usdcAta);
  await send(
    conn,
    order(lin, payer, REJECT_SIZE),
    [payer],
    "PlaceOrder(the SAME 80e6 trade the coin-margin market rejected)",
  );
  check(
    (await positions(conn, lin.userPf)).some((p) => p.assetIndex === 0 && p.side === Side.Long),
    "USDC market accepts it at 10x (10% im = 8 < 12 capital): the tier is coin-margin-specific",
  );

  console.log(`\nALL COIN-MARGIN CHECKS PASSED (${passes})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
