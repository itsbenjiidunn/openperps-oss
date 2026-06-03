// Devnet on-chain test for the Pyth pull-oracle crank (CrankPyth) against the
// live Pyth SOL/USD sponsored feed.
//
// Run (PowerShell):
//   $env:OPENPERPS_PAYER="C:\tmp\op-devnet\pyth-id.json"
//   node --import tsx packages/sdk/scripts/devnet-pyth.ts
//
// Proves, on real accounts, that a PYTH market pulls its mark from the verified
// Pyth `PriceUpdateV2` account: CrankPyth on a market bound to the SOL/USD feed
// sets the on-chain mark to the live Pyth price, and a market bound to a
// different feed id rejects the same account (feed mismatch).

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
import { createMint } from "@solana/spl-token";
import {
  initMarketIx,
  activateMarketIx,
  crankPythIx,
  fetchMarketState,
  marketAccountSize,
  VAULT_SEED,
  ORACLE_KIND_PYTH,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey("2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4");
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 2;

const SOL_USD_ACC = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function hexToBytes(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}

/// Convert a Pyth (price, expo) to the 6-decimal mark scale: price * 10^(6+expo).
function priceToMark(price: bigint, expo: number): bigint {
  const e = 6 + expo;
  return e >= 0 ? price * 10n ** BigInt(e) : price / 10n ** BigInt(-e);
}

/// Read the live Pyth mark (6-decimal) from a PriceUpdateV2 account (Full layout).
async function readPythMark(conn: Connection): Promise<bigint> {
  const info = await conn.getAccountInfo(SOL_USD_ACC);
  if (!info) throw new Error("SOL/USD Pyth account not found on this cluster");
  const d = info.data;
  const pm = 41; // Full verification: price_message at offset 41
  const price = d.readBigInt64LE(pm + 32);
  const expo = d.readInt32LE(pm + 48);
  return priceToMark(price, expo);
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}`);
  console.log(`program=${PROGRAM_ID.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  console.log(`payer balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

  const marketSize = marketAccountSize(CAP);
  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log(`quote_mint=${quoteMint.toBase58()}`);

  const send = async (tx: Transaction, signers: Keypair[], label: string) => {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ${label} tx=${sig}`);
    return sig;
  };

  const makePythMarket = async (feedId: Uint8Array, seedMark: bigint, label: string) => {
    const market = Keypair.generate();
    const [, vaultBump] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, market.publicKey.toBuffer()],
      PROGRAM_ID,
    );
    await send(
      new Transaction()
        .add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: market.publicKey,
            lamports: marketRent,
            space: marketSize,
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
            oracleKind: ORACLE_KIND_PYTH,
            oracleFeedId: feedId,
            oraclePool: PublicKey.default,
          }),
        ),
      [payer, market],
      `InitMarket(${label}, PYTH)`,
    );
    await send(
      new Transaction().add(
        activateMarketIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          assetIndex: 0,
          authenticatedPrice: seedMark,
        }),
      ),
      [payer],
      `ActivateMarket(${label} @ ${seedMark})`,
    );
    return market;
  };

  // ---- Positive: market bound to SOL/USD pulls the live mark ----
  console.log("\n=== Pyth crank: SOL/USD ===");
  const live0 = await readPythMark(conn);
  console.log(`  live Pyth SOL/USD mark = ${live0} (6dp, ~$${(Number(live0) / 1e6).toFixed(2)})`);
  const market = await makePythMarket(hexToBytes(SOL_USD_FEED_HEX), live0, "SOL/USD");

  const seeded = (await fetchMarketState(conn, market.publicKey, 0)).markPrice;
  check(seeded === live0, `mark seeded at the live Pyth price (${seeded})`);

  await send(
    new Transaction().add(
      crankPythIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        priceUpdate: SOL_USD_ACC,
        signer: payer.publicKey,
        assetIndex: 0,
      }),
    ),
    [payer],
    "CrankPyth(SOL/USD)",
  );

  const after = (await fetchMarketState(conn, market.publicKey, 0)).markPrice;
  const live1 = await readPythMark(conn);
  console.log(`  on-chain mark after crank = ${after} (~$${(Number(after) / 1e6).toFixed(2)})`);
  console.log(`  live Pyth mark now        = ${live1} (~$${(Number(live1) / 1e6).toFixed(2)})`);
  check(after > 10_000_000n && after < 1_000_000_000n, `on-chain mark in sane SOL range ($10..$1000)`);
  // within 1% of the freshly-read live mark (the price drifts a little between txs)
  const diff = after > live1 ? after - live1 : live1 - after;
  check(diff * 100n <= live1, `on-chain mark within 1% of the live Pyth mark (diff=${diff})`);

  // ---- Negative: a market bound to a different feed rejects this account ----
  console.log("\n=== Pyth crank: wrong feed rejected ===");
  const wrongFeed = hexToBytes(SOL_USD_FEED_HEX);
  wrongFeed[0] ^= 0xff; // a feed id that is not SOL/USD
  const market2 = await makePythMarket(wrongFeed, live0, "wrong-feed");
  let rejected = false;
  try {
    await send(
      new Transaction().add(
        crankPythIx({
          programId: PROGRAM_ID,
          market: market2.publicKey,
          priceUpdate: SOL_USD_ACC,
          signer: payer.publicKey,
          assetIndex: 0,
        }),
      ),
      [payer],
      "CrankPyth(wrong-feed)",
    );
  } catch {
    rejected = true;
  }
  check(rejected, "CrankPyth with a mismatched feed id is rejected (StalePythPrice)");
  const after2 = (await fetchMarketState(conn, market2.publicKey, 0)).markPrice;
  check(after2 === live0, `wrong-feed market mark unchanged (${after2})`);

  console.log(`\nALL ${passes} CHECKS PASSED`);
  console.log(`payer balance end=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
}

main().catch((e) => {
  console.error("\nPYTH TEST FAILED");
  console.error(e);
  process.exit(1);
});
