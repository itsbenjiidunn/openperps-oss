// On-chain test for PlaceBatchOrder: apply several trade legs (user vs House) in
// one tx with a single margin check, and reject a batch larger than the market's
// asset capacity.
//
// Run (PowerShell):
//   $env:OPENPERPS_PAYER="C:\tmp\op-devnet\pyth-id.json"
//   node --import tsx packages/sdk/scripts/batch-order.ts

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
  initPortfolioIx,
  depositIx,
  activateMarketIx,
  placeBatchOrderIx,
  portfolioPda,
  marketAccountSize,
  readU128LE,
  OFFSET_CAPITAL,
  HOUSE_SEED,
  VAULT_SEED,
  ORACLE_KIND_MANUAL,
  Side,
  DEVNET_PROGRAM_ID,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey(DEVNET_PROGRAM_ID);
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 2;
const POS_SCALE = 1_000_000n;
const P0 = 100_000_000n; // seed mark for both slots
const USER_DEPOSIT = 50_000_000n; // $50
const HOUSE_FUND = 200_000_000n; // $200
const SIZE_Q = 1_000_000n;
const FEE_BPS = 10n;

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}
function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`program=${PROGRAM_ID.toBase58()}  payer=${payer.publicKey.toBase58()}`);
  console.log(`balance=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

  const send = async (tx: Transaction, signers: Keypair[], label: string) => {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ${label} tx=${sig}`);
    return sig;
  };
  const capitalOf = async (acc: PublicKey) =>
    readU128LE(new Uint8Array((await conn.getAccountInfo(acc))!.data), OFFSET_CAPITAL);

  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
  await mintTo(conn, payer, quoteMint, payerAta, payer, 1_000_000_000n);

  const market = Keypair.generate();
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [userPf, userPfBump] = portfolioPda(PROGRAM_ID, payer.publicKey, market.publicKey);

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
          baseMint: PublicKey.default,
          oracleKind: ORACLE_KIND_MANUAL,
          oracleFeedId: new Uint8Array(32),
          oraclePool: PublicKey.default,
        }),
      ),
    [payer, market],
    "InitMarket",
  );
  await send(
    new Transaction().add(
      createVaultIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, vault: vaultPda, quoteMint }),
    ),
    [payer],
    "CreateVault",
  );
  // Activate BOTH asset slots so the batch can touch two assets. The engine
  // enforces asset_activation_cooldown_slots between activations, so wait a beat.
  await send(
    new Transaction().add(
      activateMarketIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, assetIndex: 0, authenticatedPrice: P0 }),
    ),
    [payer],
    "ActivateMarket(slot 0)",
  );
  await new Promise((r) => setTimeout(r, 1500));
  await send(
    new Transaction().add(
      activateMarketIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, assetIndex: 1, authenticatedPrice: P0 }),
    ),
    [payer],
    "ActivateMarket(slot 1)",
  );
  await send(
    new Transaction().add(
      createHouseVaultIx({ programId: PROGRAM_ID, market: market.publicKey, authority: payer.publicKey, housePortfolio: housePda, houseBump }),
    ),
    [payer],
    "CreateHouseVault",
  );
  await send(
    new Transaction().add(
      fundHouseVaultIx({ programId: PROGRAM_ID, market: market.publicKey, housePortfolio: housePda, authority: payer.publicKey, authorityToken: payerAta, vaultToken: vaultPda, amount: HOUSE_FUND }),
    ),
    [payer],
    "FundHouseVault",
  );
  await send(
    new Transaction().add(
      initPortfolioIx({ programId: PROGRAM_ID, portfolio: userPf, market: market.publicKey, owner: payer.publicKey, bump: userPfBump }),
    ),
    [payer],
    "InitPortfolio(user)",
  );
  await send(
    new Transaction().add(
      depositIx({ programId: PROGRAM_ID, market: market.publicKey, portfolio: userPf, owner: payer.publicKey, userToken: payerAta, vaultToken: vaultPda, amount: USER_DEPOSIT }),
    ),
    [payer],
    "Deposit",
  );

  // ---- 1) Batch: two legs (user long asset 0 and asset 1), one margin check ----
  console.log("\n=== PlaceBatchOrder (2 legs) ===");
  const leg = (assetIndex: number) => ({
    side: Side.Long,
    assetIndex,
    sizeQ: SIZE_Q,
    execPrice: P0,
    feeBps: FEE_BPS,
  });
  await send(
    new Transaction().add(
      placeBatchOrderIx({
        programId: PROGRAM_ID,
        market: market.publicKey,
        userPortfolio: userPf,
        housePortfolio: housePda,
        user: payer.publicKey,
        legs: [leg(0), leg(1)],
      }),
    ),
    [payer],
    "PlaceBatchOrder(2 legs)",
  );

  const notional = (SIZE_Q * P0) / POS_SCALE;
  const feePerLeg = (notional * FEE_BPS) / 10_000n;
  const sumFee = feePerLeg * 2n;
  const userCap = await capitalOf(userPf);
  const houseCap = await capitalOf(housePda);
  console.log(`  user.capital=${userCap}  house.capital=${houseCap}  sumFee=${sumFee}`);
  check(userCap === USER_DEPOSIT - sumFee, `user capital = deposit - sum(leg fees) (${userCap})`);
  check(houseCap === HOUSE_FUND - sumFee, `house capital = fund - sum(leg fees) (${houseCap})`);

  // ---- 2) A batch larger than the market's asset capacity is rejected ----
  console.log("\n=== oversized batch rejected ===");
  let rejected = false;
  try {
    await send(
      new Transaction().add(
        placeBatchOrderIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          userPortfolio: userPf,
          housePortfolio: housePda,
          user: payer.publicKey,
          legs: [leg(0), leg(1), leg(0)], // 3 legs > max_portfolio_assets (2)
        }),
      ),
      [payer],
      "PlaceBatchOrder(3 legs)",
    );
  } catch {
    rejected = true;
  }
  check(rejected, "batch with more legs than the asset capacity is rejected");
  const userCap2 = await capitalOf(userPf);
  check(userCap2 === userCap, `user capital unchanged after the rejected batch (${userCap2})`);

  console.log(`\nALL ${passes} CHECKS PASSED`);
  console.log(`balance end=${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
}

main().catch((e) => {
  console.error("\nBATCH TEST FAILED");
  console.error(e);
  process.exit(1);
});
