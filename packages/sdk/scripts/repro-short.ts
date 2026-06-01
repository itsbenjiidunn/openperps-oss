import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { initPortfolioIx, depositIx, placeOrderIx, Side, portfolioAccountSize, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";
const RPC="https://devnet.helius-rpc.com/?api-key=REDACTED";
const PROGRAM=new PublicKey("4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy");
const MARKET=new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const VAULT=new PublicKey("75LaQ2aGjbk5XrHUEFy8AgGkLCX72DA2zcjx6qHHFm7R");
const HOUSE=new PublicKey("5buZR7SrG6D3t2Ste5HkmWxSkaDwZpmSYvFDuwwcxKqa");
const QUOTE=new PublicKey("9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat");
const conn=new Connection(RPC,"confirmed");
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../../deploy/payer.json","utf8"))));
const d=(await conn.getAccountInfo(MARKET))!.data;
async function run(SLOT:number, side:Side, label:string){
  const px=Number(d.readBigUInt64LE(slotEffectivePriceOffset(SLOT)));
  const pxUsd=px/Number(PRICE_SCALE);
  const pf=Keypair.generate();
  const size=portfolioAccountSize(16); const rent=await conn.getMinimumBalanceForRentExemption(size);
  const tx1=new Transaction()
    .add(SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:pf.publicKey,lamports:rent,space:size,programId:PROGRAM}))
    .add(initPortfolioIx({programId:PROGRAM,portfolio:pf.publicKey,market:MARKET,owner:payer.publicKey,portfolioAccountId:randomBytes(32)}));
  await sendAndConfirmTransaction(conn,tx1,[payer,pf],{commitment:"confirmed"});
  const ata=getAssociatedTokenAddressSync(QUOTE,payer.publicKey);
  await sendAndConfirmTransaction(conn,new Transaction().add(depositIx({programId:PROGRAM,market:MARKET,portfolio:pf.publicKey,owner:payer.publicKey,userToken:ata,vaultToken:VAULT,amount:2_000_000_000n})),[payer],{commitment:"confirmed"});
  const sizeQ=BigInt(Math.round((1000*1e6)/pxUsd));
  const tx=new Transaction().add(placeOrderIx({programId:PROGRAM,market:MARKET,userPortfolio:pf.publicKey,housePortfolio:HOUSE,user:payer.publicKey,side,assetIndex:SLOT,sizeQ,execPrice:BigInt(px),feeBps:10n}));
  tx.feePayer=payer.publicKey; tx.recentBlockhash=(await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(payer);
  const r=await conn.simulateTransaction(tx);
  console.log(`${label} slot${SLOT} px=${pxUsd.toFixed(2)} err=${JSON.stringify(r.value.err)}`);
  (r.value.logs??[]).filter(l=>/Program log|failed|consumed 4|invoke \[1\]/.test(l)).slice(-4).forEach(l=>console.log("   ",l));
}
await run(3, Side.Short, "SHORT ETH");
await run(0, Side.Long,  "LONG  SOL");
await run(0, Side.Short, "SHORT SOL");
