// On-chain test for the DEX-EWMA spot crank (CrankDexSpot): price a
// DEX_EWMA market from two real SPL token vaults (constant-product reserves),
// track a pool move, and reject a pool below the depth floor.
//
// Run (PowerShell):
//   $env:OPENPERPS_PAYER="C:\tmp\op-devnet\pyth-id.json"
//   node --import tsx packages/sdk/scripts/dex-crank.ts
//
// The two "pool vaults" are plain SPL token accounts with known balances, the
// same format a real CP-AMM (e.g. Raydium CPMM) keeps its reserves in, so this
// exercises the exact on-chain read path used against a real pool on mainnet.

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
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import {
  initMarketIx,
  activateMarketIx,
  setDexPoolIx,
  crankDexSpotIx,
  dexPoolPda,
  fetchMarketState,
  marketAccountSize,
  VAULT_SEED,
  ORACLE_KIND_DEX_EWMA,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey("2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4");
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 2;
const BASE_DECIMALS = 9;

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}
/// spot = reserve_quote * 10^base_decimals / reserve_base, in the 6dp mark scale.
function spot(reserveBase: bigint, reserveQuote: bigint): bigint {
  return (reserveQuote * 10n ** BigInt(BASE_DECIMALS)) / reserveBase;
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}`);
  console.log(`program=${PROGRAM_ID.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  console.log(`payer balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

  const send = async (tx: Transaction, signers: Keypair[], label: string) => {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ${label} tx=${sig}`);
    return sig;
  };

  // Base + quote mints, and two token accounts used as the pool reserves.
  const baseMint = await createMint(conn, payer, payer.publicKey, null, BASE_DECIMALS);
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6); // mUSDC
  const baseVault = await createAccount(conn, payer, baseMint, payer.publicKey, Keypair.generate());
  const quoteVault = await createAccount(conn, payer, quoteMint, payer.publicKey, Keypair.generate());
  console.log(`baseMint=${baseMint.toBase58()} quoteMint=${quoteMint.toBase58()}`);
  console.log(`baseVault=${baseVault.toBase58()} quoteVault=${quoteVault.toBase58()}`);

  // Seed reserves: 1000 base, 75,000 mUSDC -> $75.000000 -> mark 75_000_000.
  const RESERVE_BASE = 1_000n * 10n ** BigInt(BASE_DECIMALS);
  let reserveQuote = 75_000n * 1_000_000n;
  await mintTo(conn, payer, baseMint, baseVault, payer, RESERVE_BASE);
  await mintTo(conn, payer, quoteMint, quoteVault, payer, reserveQuote);
  const s0 = spot(RESERVE_BASE, reserveQuote);
  console.log(`pool spot S0 = ${s0} (~$${(Number(s0) / 1e6).toFixed(2)})`);

  // DEX_EWMA market, activated at the pool spot.
  const market = Keypair.generate();
  const [, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const marketSize = marketAccountSize(CAP);
  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);
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
          baseMint,
          oracleKind: ORACLE_KIND_DEX_EWMA,
          oracleFeedId: new Uint8Array(32),
          oraclePool: PublicKey.default,
        }),
      ),
    [payer, market],
    "InitMarket(DEX_EWMA)",
  );
  await send(
    new Transaction().add(
      activateMarketIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        authenticatedPrice: s0,
      }),
    ),
    [payer],
    `ActivateMarket(@ ${s0})`,
  );

  const [cfgPda, cfgBump] = dexPoolPda(PROGRAM_ID, market.publicKey);
  const setPool = (minQuoteDepth: bigint, label: string) =>
    send(
      new Transaction().add(
        setDexPoolIx({
          programId: PROGRAM_ID,
          dexPoolPda: cfgPda,
          market: market.publicKey,
          authority: payer.publicKey,
          baseVault,
          quoteVault,
          baseDecimals: BASE_DECIMALS,
          minQuoteDepth,
          bump: cfgBump,
        }),
      ),
      [payer],
      label,
    );
  const crank = (label: string) =>
    send(
      new Transaction().add(
        crankDexSpotIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          dexPoolPda: cfgPda,
          baseVault,
          quoteVault,
          signer: payer.publicKey,
          assetIndex: 0,
        }),
      ),
      [payer],
      label,
    );

  // ---- 1) Bind the pool (floor $1,000) and crank: mark holds at the spot ----
  console.log("\n=== DEX spot crank ===");
  await setPool(1_000n * 1_000_000n, "SetDexPool(floor $1,000)");
  await crank("CrankDexSpot #1");
  const m1 = (await fetchMarketState(conn, market.publicKey, 0)).markPrice;
  console.log(`  mark after crank #1 = ${m1} (~$${(Number(m1) / 1e6).toFixed(2)})`);
  check(m1 === s0, `mark equals the pool spot (${m1})`);

  // ---- 2) Move the pool up (mint +10,000 mUSDC) and crank: mark tracks up ----
  await mintTo(conn, payer, quoteMint, quoteVault, payer, 10_000n * 1_000_000n);
  reserveQuote += 10_000n * 1_000_000n;
  const s1 = spot(RESERVE_BASE, reserveQuote);
  console.log(`  pool spot raised to S1 = ${s1} (~$${(Number(s1) / 1e6).toFixed(2)})`);
  await crank("CrankDexSpot #2");
  const m2 = (await fetchMarketState(conn, market.publicKey, 0)).markPrice;
  console.log(`  mark after crank #2 = ${m2} (~$${(Number(m2) / 1e6).toFixed(2)})`);
  check(m2 > m1 && m2 <= s1, `mark moved up toward the new spot (EWMA + per-slot clamp)`);

  // ---- 3) Depth gate: raise the floor above the pool depth, crank rejects ----
  console.log("\n=== depth gate ===");
  await setPool(100_000n * 1_000_000n, "SetDexPool(floor $100,000 > pool $85,000)");
  let rejected = false;
  try {
    await crank("CrankDexSpot (thin)");
  } catch {
    rejected = true;
  }
  check(rejected, "CrankDexSpot below the depth floor is rejected (PoolTooThin)");
  const m3 = (await fetchMarketState(conn, market.publicKey, 0)).markPrice;
  check(m3 === m2, `mark unchanged after the rejected crank (${m3})`);

  console.log(`\nALL ${passes} CHECKS PASSED`);
  console.log(`payer balance end=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
}

main().catch((e) => {
  console.error("\nDEX TEST FAILED");
  console.error(e);
  process.exit(1);
});
