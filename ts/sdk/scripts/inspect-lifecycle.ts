import { Connection, PublicKey } from "@solana/web3.js";
import { slotOffset, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";
const RPC = process.env.OPENPERPS_RPC ?? "https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const LC = ["Disabled","PendingActivation","Active","DrainOnly","Retired","Recovery"];
const conn = new Connection(RPC, "confirmed");
const info = await conn.getAccountInfo(MARKET);
const d = info!.data;
for (let i = 0; i < 6; i++) {
  const off = slotOffset(i);
  const lcByte = d[off + 48];                 // asset.lifecycle (wrapper32 + market_id8 + retired8)
  const po = slotEffectivePriceOffset(i);
  const price = d.length >= po+8 ? d.readBigUInt64LE(po) : 0n;
  console.log(`slot ${i}  lifecycle=${lcByte} (${LC[lcByte!] ?? "?"})  usd=${Number(price)/Number(PRICE_SCALE)}`);
}
