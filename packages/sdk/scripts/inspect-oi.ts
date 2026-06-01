import { Connection, PublicKey } from "@solana/web3.js";
import { slotOffset, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";
const RPC="https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET=new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const d=(await new Connection(RPC,"confirmed").getAccountInfo(MARKET))!.data;
for (let i=0;i<6;i++){const b=slotOffset(i)+32;const oiL=d.readBigUInt64LE(b+273);const oiS=d.readBigUInt64LE(b+289);const eff=d.readBigUInt64LE(slotEffectivePriceOffset(i));
console.log(`slot ${i} oiLong=${Number(oiL)/1e6} oiShort=${Number(oiS)/1e6} eff=${Number(eff)/Number(PRICE_SCALE)}`);}
