import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { initPortfolioIx, depositIx, placeOrderIx, accrueAssetIx, Side, portfolioAccountSize, slotOffset, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";
const RPC="https://devnet.helius-rpc.com/?api-key=REDACTED";
const PROGRAM=new PublicKey("4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy");
const MARKET=new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const VAULT=new PublicKey("75LaQ2aGjbk5XrHUEFy8AgGkLCX72DA2zcjx6qHHFm7R");
const HOUSE=new PublicKey("5buZR7SrG6D3t2Ste5HkmWxSkaDwZpmSYvFDuwwcxKqa");
const QUOTE=new PublicKey("9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat");
const conn=new Connection(RPC,"confirmed");
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../../deploy/payer.json","utf8"))));
const d=(await conn.getAccountInfo(MARKET))!.data;
// find OI slots
const oiSlots:number[]=[];
for(let i=0;i<16;i++){const b=slotOffset(i)+32; if(b+289+8>d.length)break; const oiL=d.readBigUInt64LE(b+273),oiS=d.readBigUInt64LE(b+289); if(oiL>0n||oiS>0n)oiSlots.push(i);}
console.log("OI slots:",oiSlots);
const accrues=oiSlots.map(s=>accrueAssetIx({programId:PROGRAM,market:MARKET,authority:payer.publicKey,assetIndex:s,effectivePrice:d.readBigUInt64LE(slotEffectivePriceOffset(s)),fundingRateE9:0n}));

const SLOT=0; const px=Number(d.readBigUInt64LE(slotEffectivePriceOffset(SLOT))); const pxUsd=px/Number(PRICE_SCALE);
const pf=Keypair.generate();
const size=portfolioAccountSize(16); const rent=await conn.getMinimumBalanceForRentExemption(size);
await sendAndConfirmTransaction(conn,new Transaction()
  .add(SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:pf.publicKey,lamports:rent,space:size,programId:PROGRAM}))
  .add(initPortfolioIx({programId:PROGRAM,portfolio:pf.publicKey,market:MARKET,owner:payer.publicKey,portfolioAccountId:randomBytes(32)})),[payer,pf],{commitment:"confirmed"});
const ata=getAssociatedTokenAddressSync(QUOTE,payer.publicKey);
await sendAndConfirmTransaction(conn,new Transaction().add(depositIx({programId:PROGRAM,market:MARKET,portfolio:pf.publicKey,owner:payer.publicKey,userToken:ata,vaultToken:VAULT,amount:2_000_000_000n})),[payer],{commitment:"confirmed"});
const sizeQ=BigInt(Math.round((1000*1e6)/pxUsd));
const order=placeOrderIx({programId:PROGRAM,market:MARKET,userPortfolio:pf.publicKey,housePortfolio:HOUSE,user:payer.publicKey,side:Side.Short,assetIndex:SLOT,sizeQ,execPrice:BigInt(px),feeBps:10n});

// WITHOUT accrue prefix
const t1=new Transaction().add(order); t1.feePayer=payer.publicKey; t1.recentBlockhash=(await conn.getLatestBlockhash("confirmed")).blockhash; t1.sign(payer);
const r1=await conn.simulateTransaction(t1);
console.log("SHORT without accrue-prefix: err=",JSON.stringify(r1.value.err));
// WITH accrue prefix for all OI slots
const t2=new Transaction().add(...accrues, order); t2.feePayer=payer.publicKey; t2.recentBlockhash=(await conn.getLatestBlockhash("confirmed")).blockhash; t2.sign(payer);
const r2=await conn.simulateTransaction(t2);
console.log("SHORT WITH accrue-prefix:    err=",JSON.stringify(r2.value.err));
(r2.value.logs??[]).filter(l=>/failed|Program log/.test(l)).slice(-3).forEach(l=>console.log("   ",l));
