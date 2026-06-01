/// One-off: print which asset slots in the shared market group are occupied
/// (wrapper non-zero or a live mark) and their current effective price.
///   tsx scripts/inspect-slots.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { slotOffset, slotEffectivePriceOffset, PRICE_SCALE } from "../src/index.ts";

const RPC =
  process.env.OPENPERPS_RPC ??
  "https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");

const conn = new Connection(RPC, "confirmed");
const info = await conn.getAccountInfo(MARKET);
if (!info) {
  console.log("NO ACCOUNT");
  process.exit(1);
}
const d = info.data;
console.log("account len", d.length);
for (let i = 0; i < 16; i++) {
  const off = slotOffset(i);
  if (off + 32 > d.length) {
    console.log(i, "OOB");
    break;
  }
  let zero = true;
  for (let b = 0; b < 32; b++)
    if (d[off + b] !== 0) {
      zero = false;
      break;
    }
  const po = slotEffectivePriceOffset(i);
  let price = 0n;
  if (d.length >= po + 8) price = d.readBigUInt64LE(po);
  console.log(
    `slot ${i}  wrapperZero=${zero}  effPriceAtoms=${price.toString()}  usd=${
      Number(price) / Number(PRICE_SCALE)
    }`,
  );
}
