import { Connection, PublicKey } from "@solana/web3.js";
import { WRAPPER_HEADER_SIZE } from "../src/index.ts";
const RPC = process.env.OPENPERPS_RPC ?? "https://devnet.helius-rpc.com/?api-key=REDACTED";
const MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
const conn = new Connection(RPC, "confirmed");
const d = (await conn.getAccountInfo(MARKET))!.data;
const base = WRAPPER_HEADER_SIZE; // 208
console.log("bankruptcy_hlock_active =", d[base+501]);
console.log("threshold_stress_active =", d[base+502]);
console.log("loss_stale_active       =", d[base+503]);
console.log("recovery_reason.present =", d[base+504], " value =", d[base+505]);
console.log("mode (0=Live)           =", d[base+506]);
console.log("negative_pnl_account_count =", d.readBigUInt64LE(base+429).toString());
console.log("stale_certificate_count    =", d.readBigUInt64LE(base+405).toString());
console.log("b_stale_account_count      =", d.readBigUInt64LE(base+413).toString());
