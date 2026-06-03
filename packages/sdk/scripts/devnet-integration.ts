// Devnet integration test for the Phase 1.1 (rotatable oracle authority) and
// Phase 2.1 (per-market deposit cap) instructions, against the deployed program.
//
// Run (PowerShell), with the funded devnet keypair and the deployed program id:
//   $env:OPENPERPS_PAYER="C:\tmp\op-devnet\id.json"
//   node --import tsx packages/sdk/scripts/devnet-integration.ts
//
// It proves, on real accounts, that:
//   A) AccrueAsset cannot move a market's mark unless the signer is the market's
//      oracle authority. The SAME signer is rejected before SetOracleAuthority
//      (mark stays put) and accepted after it (mark moves). Revoking (zero key)
//      locks the mark again.
//   B) A DEX-priced market enforces the $1000 per-portfolio collateral floor, and
//      SetDepositCap raises it: a deposit that overflows the floor reverts, then
//      the same deposit succeeds once the cap PDA is in place.

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
  initPortfolioIx,
  activateMarketIx,
  accrueAssetIx,
  depositIx,
  setOracleAuthorityIx,
  oracleAuthorityPda,
  setDepositCapIx,
  depositCapPda,
  portfolioPda,
  marketAccountSize,
  fetchMarketState,
  readU128LE,
  OFFSET_CAPITAL,
  VAULT_SEED,
  ORACLE_KIND_MANUAL,
  ORACLE_KIND_DEX_EWMA,
} from "../src/index.ts";

const PROGRAM_ID = new PublicKey("2TGY1iY2r4MKytwg5vir9CJnJrqgdZrzjF8LjNaiVnZ4");
const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH =
  process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");
const CAP = 2; // asset slot capacity

const P0 = 100_000_000n; // u64 mark seeded at activation
const P1 = 100_010_000n; // +1bp; within the 10bps/slot move bound for one slot

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function send(
  conn: Connection,
  ixs: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const sig = await sendAndConfirmTransaction(conn, ixs, signers, {
    commitment: "confirmed",
  });
  console.log(`  ${label} tx=${sig}`);
  return sig;
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
  throw new Error(`ASSERT FAILED: ${label} (expected revert, but it succeeded)`);
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}`);
  console.log(`program=${PROGRAM_ID.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`payer balance=${bal / 1e9} SOL`);

  const info = await conn.getAccountInfo(PROGRAM_ID);
  if (!info) throw new Error(`program ${PROGRAM_ID.toBase58()} not deployed on ${RPC}`);
  check(info.executable, "program is deployed and executable");

  const marketSize = marketAccountSize(CAP);
  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);

  // Shared mock-USDC mint + payer ATA (reused by both tests).
  console.log("\ncreating mock-USDC mint + funding payer ATA...");
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const payerAta = await createAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
  await mintTo(conn, payer, quoteMint, payerAta, payer, 10_000_000_000n); // $10,000
  console.log(`quote_mint=${quoteMint.toBase58()}  payer_ata=${payerAta.toBase58()}`);

  const makeMarket = async (oracleKind: number, label: string) => {
    const market = Keypair.generate();
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, market.publicKey.toBuffer()],
      PROGRAM_ID,
    );
    const tx = new Transaction()
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
          oracleKind,
          oracleFeedId: new Uint8Array(32),
          oraclePool: PublicKey.default,
        }),
      );
    await send(conn, tx, [payer, market], `InitMarket(${label})`);
    await send(
      conn,
      new Transaction().add(
        createVaultIx({
          programId: PROGRAM_ID,
          market: market.publicKey,
          authority: payer.publicKey,
          vault: vaultPda,
          quoteMint,
        }),
      ),
      [payer],
      `CreateVault(${label})`,
    );
    return { market, vaultPda };
  };

  // Portfolio is the deterministic PDA [PORTFOLIO_SEED, owner, market]; the
  // program creates the account itself (the PDA signs), so the client only
  // derives the address + bump and signs as owner (rent payer).
  const makePortfolio = async (market: PublicKey, label: string): Promise<PublicKey> => {
    const [pda, bump] = portfolioPda(PROGRAM_ID, payer.publicKey, market);
    const tx = new Transaction().add(
      initPortfolioIx({
        programId: PROGRAM_ID,
        portfolio: pda,
        market,
        owner: payer.publicKey,
        bump,
      }),
    );
    await send(conn, tx, [payer], `InitPortfolio(${label})`);
    return pda;
  };

  // ------------------------------------------------------------------
  // TEST A: rotatable oracle authority (Phase 1.1)
  // ------------------------------------------------------------------
  section("TEST A: rotatable oracle authority");
  const { market: mA } = await makeMarket(ORACLE_KIND_MANUAL, "A/manual");

  await send(
    conn,
    new Transaction().add(
      activateMarketIx({
        programId: PROGRAM_ID,
        market: mA.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        authenticatedPrice: P0,
      }),
    ),
    [payer],
    "ActivateMarket(slot0 @ P0)",
  );
  let st = await fetchMarketState(conn, mA.publicKey, 0);
  check(st.markPrice === P0, `mark seeded at P0 (${st.markPrice})`);

  // A1: payer is NOT the oracle authority yet -> AccrueAsset forced to delta-0.
  await send(
    conn,
    new Transaction().add(
      accrueAssetIx({
        programId: PROGRAM_ID,
        market: mA.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        effectivePrice: P1,
        fundingRateE9: 0n,
      }),
    ),
    [payer],
    "AccrueAsset(P1) WITHOUT oracle-authority PDA",
  );
  st = await fetchMarketState(conn, mA.publicKey, 0);
  check(st.markPrice === P0, `mark UNCHANGED by non-authority (still ${st.markPrice})`);

  // A2: grant the payer the oracle authority for this market.
  const [oraPda, oraBump] = oracleAuthorityPda(PROGRAM_ID, mA.publicKey);
  await send(
    conn,
    new Transaction().add(
      setOracleAuthorityIx({
        programId: PROGRAM_ID,
        oracleAuthorityPda: oraPda,
        market: mA.publicKey,
        authority: payer.publicKey,
        newAuthority: payer.publicKey,
        bump: oraBump,
      }),
    ),
    [payer],
    "SetOracleAuthority(payer)",
  );
  {
    const acc = await conn.getAccountInfo(oraPda);
    if (!acc) throw new Error("oracle authority PDA not created");
    const d = new Uint8Array(acc.data);
    const disc = Buffer.from(d.slice(0, 8)).toString("ascii");
    const mkt = new PublicKey(d.slice(8, 40));
    const auth = new PublicKey(d.slice(40, 72));
    check(disc === "OPORAUTH", `oracle PDA discriminator = ${disc}`);
    check(mkt.equals(mA.publicKey), "oracle PDA bound to market A");
    check(auth.equals(payer.publicKey), "oracle PDA authority = payer");
  }

  // A3: now the payer IS the oracle authority -> AccrueAsset moves the mark.
  await send(
    conn,
    new Transaction().add(
      accrueAssetIx({
        programId: PROGRAM_ID,
        market: mA.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        effectivePrice: P1,
        fundingRateE9: 0n,
        oracleAuthority: oraPda,
      }),
    ),
    [payer],
    "AccrueAsset(P1) WITH oracle-authority PDA",
  );
  st = await fetchMarketState(conn, mA.publicKey, 0);
  console.log(`  mark after authorized accrue = ${st.markPrice} (target P1=${P1})`);
  check(st.markPrice > P0, "mark MOVED up once payer is the oracle authority");

  // A4: revoke (zero key) -> the gate falls back to the constant; payer locked out again.
  await send(
    conn,
    new Transaction().add(
      setOracleAuthorityIx({
        programId: PROGRAM_ID,
        oracleAuthorityPda: oraPda,
        market: mA.publicKey,
        authority: payer.publicKey,
        newAuthority: PublicKey.default,
        bump: oraBump,
      }),
    ),
    [payer],
    "SetOracleAuthority(revoke -> zero)",
  );
  const markBeforeRevokeTest = (await fetchMarketState(conn, mA.publicKey, 0)).markPrice;
  await send(
    conn,
    new Transaction().add(
      accrueAssetIx({
        programId: PROGRAM_ID,
        market: mA.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        effectivePrice: P0, // try to push it back down
        fundingRateE9: 0n,
        oracleAuthority: oraPda,
      }),
    ),
    [payer],
    "AccrueAsset(P0) after revoke",
  );
  st = await fetchMarketState(conn, mA.publicKey, 0);
  check(
    st.markPrice === markBeforeRevokeTest,
    `mark UNCHANGED after revoke (still ${st.markPrice})`,
  );

  // ------------------------------------------------------------------
  // TEST B: per-market deposit cap (Phase 2.1) on a DEX-priced market
  // ------------------------------------------------------------------
  section("TEST B: per-market deposit cap (DEX-priced)");
  const { market: mB, vaultPda: vaultB } = await makeMarket(ORACLE_KIND_DEX_EWMA, "B/dex");
  await send(
    conn,
    new Transaction().add(
      activateMarketIx({
        programId: PROGRAM_ID,
        market: mB.publicKey,
        authority: payer.publicKey,
        assetIndex: 0,
        authenticatedPrice: P0,
      }),
    ),
    [payer],
    "ActivateMarket(B slot0)",
  );
  const pfB = await makePortfolio(mB.publicKey, "B");

  const deposit = (amount: bigint, withCap: PublicKey | undefined, label: string) =>
    send(
      conn,
      new Transaction().add(
        depositIx({
          programId: PROGRAM_ID,
          market: mB.publicKey,
          portfolio: pfB,
          owner: payer.publicKey,
          userToken: payerAta,
          vaultToken: vaultB,
          amount,
          depositCap: withCap,
        }),
      ),
      [payer],
      label,
    );

  // B1: deposit $900 (under the $1000 floor) -> allowed.
  await deposit(900_000_000n, undefined, "Deposit $900 (under floor)");
  {
    const acc = await conn.getAccountInfo(pfB);
    const capital = readU128LE(new Uint8Array(acc!.data), OFFSET_CAPITAL);
    check(capital === 900_000_000n, `portfolio capital = $900 (${capital})`);
  }

  // B2: another $600 would push capital to $1500 > floor -> reverts.
  await expectFail(
    () => deposit(600_000_000n, undefined, "Deposit +$600 (overflows floor)"),
    "deposit overflowing the $1000 floor is rejected",
  );
  {
    const acc = await conn.getAccountInfo(pfB);
    const capital = readU128LE(new Uint8Array(acc!.data), OFFSET_CAPITAL);
    check(capital === 900_000_000n, `capital still $900 after revert (${capital})`);
  }

  // B3: raise the cap to $2000 via the deposit-cap PDA.
  const [capPda, capBump] = depositCapPda(PROGRAM_ID, mB.publicKey);
  await send(
    conn,
    new Transaction().add(
      setDepositCapIx({
        programId: PROGRAM_ID,
        depositCapPda: capPda,
        market: mB.publicKey,
        authority: payer.publicKey,
        maxCapital: 2_000_000_000n,
        bump: capBump,
      }),
    ),
    [payer],
    "SetDepositCap($2000)",
  );
  {
    const acc = await conn.getAccountInfo(capPda);
    if (!acc) throw new Error("deposit cap PDA not created");
    const d = new Uint8Array(acc.data);
    const disc = Buffer.from(d.slice(0, 8)).toString("ascii");
    const mkt = new PublicKey(d.slice(8, 40));
    const cap = readU128LE(d, 40);
    check(disc === "OPDEPCAP", `cap PDA discriminator = ${disc}`);
    check(mkt.equals(mB.publicKey), "cap PDA bound to market B");
    check(cap === 2_000_000_000n, `cap PDA max_capital = $2000 (${cap})`);
  }

  // B4: the same +$600 now succeeds because the cap PDA is supplied.
  await deposit(600_000_000n, capPda, "Deposit +$600 WITH cap PDA");
  {
    const acc = await conn.getAccountInfo(pfB);
    const capital = readU128LE(new Uint8Array(acc!.data), OFFSET_CAPITAL);
    check(capital === 1_500_000_000n, `portfolio capital = $1500 (${capital})`);
  }

  const balEnd = await conn.getBalance(payer.publicKey);
  console.log(`\nALL ${passes} CHECKS PASSED`);
  console.log(`payer balance end=${balEnd / 1e9} SOL`);
}

main().catch((e) => {
  console.error("\nINTEGRATION TEST FAILED");
  console.error(e);
  process.exit(1);
});
