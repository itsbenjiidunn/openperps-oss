import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { initMarketIx, createVaultIx, createHouseVaultIx, fundHouseVaultIx, activateMarketIx, initPortfolioIx, depositIx, placeOrderIx, accrueAssetIx, Side, marketAccountSize, portfolioAccountSize, VAULT_SEED, HOUSE_SEED, slotOffset, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";

const RPC="https://devnet.helius-rpc.com/?api-key=REDACTED";
const PROGRAM=new PublicKey("4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy");
const QUOTE=new PublicKey("9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat");
const FAUCET=Keypair.fromSecretKey(Uint8Array.from([196,54,13,224,137,112,196,54,209,253,170,100,165,253,25,148,147,110,191,122,1,40,253,13,144,18,185,162,114,77,87,137,185,53,215,136,178,161,13,254,6,192,49,243,149,196,166,33,65,189,148,254,151,211,73,181,244,232,61,255,155,180,153,76]));
const conn=new Connection(RPC,"confirmed");
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../../deploy/payer.json","utf8"))));
const CAP=4, SEED=5_000_000_000n, DEP=1_000_000_000n, PX=1.0;

// ensure payer mUSDC
const ata=await getOrCreateAssociatedTokenAccount(conn,payer,QUOTE,payer.publicKey);
if (ata.amount < SEED+DEP) { await mintTo(conn,payer,QUOTE,ata.address,FAUCET,20_000_000_000n); console.log("minted faucet mUSDC"); }

// 1) new isolated group
const market=Keypair.generate();
const [vault,vaultBump]=PublicKey.findProgramAddressSync([VAULT_SEED,market.publicKey.toBuffer()],PROGRAM);
const [house,houseBump]=PublicKey.findProgramAddressSync([HOUSE_SEED,market.publicKey.toBuffer()],PROGRAM);
const size=marketAccountSize(CAP); const rent=await conn.getMinimumBalanceForRentExemption(size);
console.log("group rent for cap",CAP,"=",(rent/1e9).toFixed(4),"SOL");
await sendAndConfirmTransaction(conn,new Transaction()
  .add(SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:market.publicKey,lamports:rent,space:size,programId:PROGRAM}))
  .add(initMarketIx({programId:PROGRAM,market:market.publicKey,authority:payer.publicKey,quoteMint:QUOTE,marketGroupId:randomBytes(32),assetSlotCapacity:CAP,vaultBump,baseMint:PublicKey.default,oracleKind:0,oracleFeedId:new Uint8Array(32),oraclePool:PublicKey.default})),[payer,market],{commitment:"confirmed"});
console.log("InitMarket OK", market.publicKey.toBase58());
await sendAndConfirmTransaction(conn,new Transaction().add(createVaultIx({programId:PROGRAM,market:market.publicKey,authority:payer.publicKey,vault,quoteMint:QUOTE})),[payer],{commitment:"confirmed"});
await sendAndConfirmTransaction(conn,new Transaction().add(createHouseVaultIx({programId:PROGRAM,market:market.publicKey,authority:payer.publicKey,housePortfolio:house,houseBump})),[payer],{commitment:"confirmed"});
await sendAndConfirmTransaction(conn,new Transaction().add(fundHouseVaultIx({programId:PROGRAM,market:market.publicKey,housePortfolio:house,authority:payer.publicKey,authorityToken:ata.address,vaultToken:vault,amount:SEED})),[payer],{commitment:"confirmed"});
console.log("Vault+House+Seed("+Number(SEED)/1e6+" mUSDC) OK");
const initialPrice=BigInt(Math.round(PX*Number(PRICE_SCALE)));
await sendAndConfirmTransaction(conn,new Transaction().add(activateMarketIx({programId:PROGRAM,market:market.publicKey,authority:payer.publicKey,assetIndex:0,authenticatedPrice:initialPrice})),[payer],{commitment:"confirmed"});
console.log("ActivateMarket(slot0 @ $"+PX+") OK");

// 2) user portfolio in THIS group + deposit
const pf=Keypair.generate(); const psize=portfolioAccountSize(CAP); const prent=await conn.getMinimumBalanceForRentExemption(psize);
await sendAndConfirmTransaction(conn,new Transaction()
  .add(SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:pf.publicKey,lamports:prent,space:psize,programId:PROGRAM}))
  .add(initPortfolioIx({programId:PROGRAM,portfolio:pf.publicKey,market:market.publicKey,owner:payer.publicKey,portfolioAccountId:randomBytes(32)})),[payer,pf],{commitment:"confirmed"});
await sendAndConfirmTransaction(conn,new Transaction().add(depositIx({programId:PROGRAM,market:market.publicKey,portfolio:pf.publicKey,owner:payer.publicKey,userToken:ata.address,vaultToken:vault,amount:DEP})),[payer],{commitment:"confirmed"});
console.log("Portfolio + Deposit("+Number(DEP)/1e6+" mUSDC) OK");

// 3) OPEN long on slot 0 (margin 200 * 5x = 1000 notional @ $1 => 1000 units)
const sizeQ=BigInt(Math.round(1000*1e6/PX));
const order=placeOrderIx({programId:PROGRAM,market:market.publicKey,userPortfolio:pf.publicKey,housePortfolio:house,user:payer.publicKey,side:Side.Long,assetIndex:0,sizeQ,execPrice:initialPrice,feeBps:10n});
const t=new Transaction().add(order); t.feePayer=payer.publicKey; t.recentBlockhash=(await conn.getLatestBlockhash("confirmed")).blockhash; t.sign(payer);
const r=await conn.simulateTransaction(t);
console.log("OPEN long (sim) err=",JSON.stringify(r.value.err));
(r.value.logs??[]).filter(l=>/failed|Program log/.test(l)).slice(-3).forEach(l=>console.log("  ",l));
