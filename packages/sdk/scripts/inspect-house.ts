import { Connection, PublicKey } from "@solana/web3.js";
import { decodePortfolioPositions } from "../src/index.ts";
const RPC="https://devnet.helius-rpc.com/?api-key=REDACTED";
const HOUSE=new PublicKey("5buZR7SrG6D3t2Ste5HkmWxSkaDwZpmSYvFDuwwcxKqa");
const conn=new Connection(RPC,"confirmed");
const info=await conn.getAccountInfo(HOUSE);
console.log("house len", info!.data.length);
const pos=decodePortfolioPositions(new Uint8Array(info!.data));
console.log("house legs:", JSON.stringify(pos.map(p=>({slot:p.assetIndex,side:p.side,size:Number(p.sizeQ)/1e6}))));
