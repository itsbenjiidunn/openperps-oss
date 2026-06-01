import { Connection, PublicKey } from "@solana/web3.js";
import { slotOffset } from "../src/index.ts";
const RPC = process.env.OPENPERPS_RPC ?? "https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const conn = new Connection(RPC, "confirmed");
const now = await conn.getSlot("confirmed");
const d = (await conn.getAccountInfo(MARKET))!.data;
console.log("current slot =", now);
for (const i of [0,1,2,3,4]) {
  const slotLast = d.readBigUInt64LE(slotOffset(i) + 32 + 41); // asset.slot_last
  const behind = BigInt(now) - slotLast;
  console.log(`slot ${i}  slot_last=${slotLast}  behind=${behind} (${(Number(behind)/100).toFixed(0)} accruals to catch up)`);
}
