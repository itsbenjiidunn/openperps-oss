/// One-off: bootstrap the single shared market group that gives OpenPerps
/// real cross-margin (one portfolio, many asset slots, one shared House).
/// Creates the group (N slots), the vault, the House Vault, mints mock-USDC
/// to the payer and seeds the House. Prints the addresses to bake into the
/// frontend (lib/sharedMarket.ts).
///
///   tsx scripts/bootstrap-shared-group.ts <payer.json>

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  createHouseVaultIx,
  createVaultIx,
  fundHouseVaultIx,
  HOUSE_SEED,
  initMarketIx,
  marketAccountSize,
  VAULT_SEED,
} from "../src/index.ts";

const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy");
const QUOTE_MINT = new PublicKey("9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat");
const FAUCET_AUTHORITY = Keypair.fromSecretKey(
  Uint8Array.from([
    196, 54, 13, 224, 137, 112, 196, 54, 209, 253, 170, 100, 165, 253, 25, 148,
    147, 110, 191, 122, 1, 40, 253, 13, 144, 18, 185, 162, 114, 77, 87, 137,
    185, 53, 215, 136, 178, 161, 13, 254, 6, 192, 49, 243, 149, 196, 166, 33,
    65, 189, 148, 254, 151, 211, 73, 181, 244, 232, 61, 255, 155, 180, 153, 76,
  ]),
);

const SLOT_CAPACITY = 16;
const HOUSE_SEED_ATOMS = 1_000_000_000_000n; // 1,000,000 mUSDC

function load(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

function rnd32(): Uint8Array {
  const a = new Uint8Array(32);
  for (let i = 0; i < 32; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = load(process.argv[2]!);
  const market = Keypair.generate();
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM,
  );
  const [house, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM,
  );

  // 1) market account + InitMarket (authority = payer, no per-asset oracle in
  //    the header; pools are pinned per slot).
  const size = marketAccountSize(SLOT_CAPACITY);
  const rent = await conn.getMinimumBalanceForRentExemption(size);
  const tx1 = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: market.publicKey,
        lamports: rent,
        space: size,
        programId: PROGRAM,
      }),
    )
    .add(
      initMarketIx({
        programId: PROGRAM,
        market: market.publicKey,
        authority: payer.publicKey,
        quoteMint: QUOTE_MINT,
        marketGroupId: rnd32(),
        assetSlotCapacity: SLOT_CAPACITY,
        vaultBump,
        baseMint: PublicKey.default,
        oracleKind: 0,
        oracleFeedId: new Uint8Array(32),
        oraclePool: PublicKey.default,
      }),
    );
  console.log("InitMarket:", await sendAndConfirmTransaction(conn, tx1, [payer, market]));

  // 2) vault
  const tx2 = new Transaction().add(
    createVaultIx({
      programId: PROGRAM,
      market: market.publicKey,
      authority: payer.publicKey,
      vault,
      quoteMint: QUOTE_MINT,
    }),
  );
  console.log("CreateVault:", await sendAndConfirmTransaction(conn, tx2, [payer]));

  // 3) House Vault portfolio
  const tx3 = new Transaction().add(
    createHouseVaultIx({
      programId: PROGRAM,
      market: market.publicKey,
      authority: payer.publicKey,
      housePortfolio: house,
      houseBump,
    }),
  );
  console.log("CreateHouseVault:", await sendAndConfirmTransaction(conn, tx3, [payer]));

  // 4) mint mock-USDC to payer, then seed the House
  const payerAta = getAssociatedTokenAddressSync(QUOTE_MINT, payer.publicKey);
  try {
    await createAssociatedTokenAccount(conn, payer, QUOTE_MINT, payer.publicKey);
  } catch {
    /* exists */
  }
  await mintTo(conn, payer, QUOTE_MINT, payerAta, FAUCET_AUTHORITY, HOUSE_SEED_ATOMS);
  const tx4 = new Transaction().add(
    fundHouseVaultIx({
      programId: PROGRAM,
      market: market.publicKey,
      housePortfolio: house,
      authority: payer.publicKey,
      authorityToken: payerAta,
      vaultToken: vault,
      amount: HOUSE_SEED_ATOMS,
    }),
  );
  console.log("FundHouseVault:", await sendAndConfirmTransaction(conn, tx4, [payer]));

  console.log(
    "\n=== BAKE INTO frontend/src/lib/sharedMarket.ts ===\n" +
      JSON.stringify(
        {
          market: market.publicKey.toBase58(),
          vault: vault.toBase58(),
          house: house.toBase58(),
          houseBump,
          slotCapacity: SLOT_CAPACITY,
        },
        null,
        2,
      ),
  );
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
