import { Connection, PublicKey } from "@solana/web3.js";
import { slotOffset, PRICE_SCALE } from "../src/index.ts";
const RPC = process.env.OPENPERPS_RPC ?? "https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const conn = new Connection(RPC, "confirmed");
const d = (await conn.getAccountInfo(MARKET))!.data;
for (const i of [0,2,3,4]) {
  const base = slotOffset(i) + 32;
  const raw = d.readBigUInt64LE(base + 17);
  const eff = d.readBigUInt64LE(base + 25);
  console.log(`slot ${i}  raw=${Number(raw)/Number(PRICE_SCALE)}  eff=${Number(eff)/Number(PRICE_SCALE)}  equal=${raw===eff}`);
}
