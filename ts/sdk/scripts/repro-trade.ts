import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { initPortfolioIx, portfolioPda, depositIx, placeOrderIx, Side, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy");
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const VAULT  = new PublicKey("75LaQ2aGjbk5XrHUEFy8AgGkLCX72DA2zcjx6qHHFm7R");
const HOUSE  = new PublicKey("5buZR7SrG6D3t2Ste5HkmWxSkaDwZpmSYvFDuwwcxKqa");
const QUOTE  = new PublicKey("9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat");
const SLOT = 0;

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../../deploy/payer.json","utf8"))));
console.log("payer", payer.publicKey.toBase58());

async function sim(label:string, tx:Transaction, signers:Keypair[]) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const r = await conn.simulateTransaction(tx);
  console.log(`\n=== ${label} === err=${JSON.stringify(r.value.err)}`);
  (r.value.logs ?? []).slice(-12).forEach(l=>console.log("  ", l));
  return r.value.err === null;
}
async function send(label:string, tx:Transaction, signers:Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, tx, signers, {commitment:"confirmed"});
  console.log(`${label} OK ${sig}`);
}

const d = (await conn.getAccountInfo(MARKET))!.data;
const px = Number(d.readBigUInt64LE(slotEffectivePriceOffset(SLOT)));   // atoms
const pxUsd = px/Number(PRICE_SCALE);
console.log("slot", SLOT, "px", pxUsd);

// 1) init portfolio at the deterministic PDA [PORTFOLIO_SEED, owner, market]
const [pf, bump] = portfolioPda(PROGRAM, payer.publicKey, MARKET);
console.log("portfolio PDA", pf.toBase58(), "bump", bump);
const existing = await conn.getAccountInfo(pf);
if (existing) {
  console.log("InitPortfolio SKIP (PDA already exists)");
} else {
  const tx1 = new Transaction()
    .add(initPortfolioIx({programId:PROGRAM,portfolio:pf,market:MARKET,owner:payer.publicKey,bump}));
  await send("InitPortfolio", tx1, [payer]);
}

// 2) deposit 2000 mUSDC
const ata = getAssociatedTokenAddressSync(QUOTE, payer.publicKey);
const tx2 = new Transaction().add(depositIx({programId:PROGRAM,market:MARKET,portfolio:pf,owner:payer.publicKey,userToken:ata,vaultToken:VAULT,amount:2_000_000_000n}));
await send("Deposit", tx2, [payer]);

// 3) OPEN long: margin 200 * 5x = 1000 notional
const sizeQ = BigInt(Math.round((1000*1e6)/pxUsd));
const execPrice = BigInt(px);
const openTx = new Transaction().add(placeOrderIx({programId:PROGRAM,market:MARKET,userPortfolio:pf,housePortfolio:HOUSE,user:payer.publicKey,side:Side.Long,assetIndex:SLOT,sizeQ,execPrice,feeBps:10n}));
const openOk = await sim("OPEN Long (sim)", openTx, [payer]);
if (openOk) await send("OPEN Long", openTx, [payer]);

// 4) CLOSE: opposite full size
const closeTx = new Transaction().add(placeOrderIx({programId:PROGRAM,market:MARKET,userPortfolio:pf,housePortfolio:HOUSE,user:payer.publicKey,side:Side.Short,assetIndex:SLOT,sizeQ,execPrice,feeBps:10n}));
await sim("CLOSE (sim)", closeTx, [payer]);
