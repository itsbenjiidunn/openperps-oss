// Verify `buildTokenMetadataIx` against the REAL Metaplex Token Metadata program on
// devnet. This is NOT part of the hermetic suite: a bare local validator has no Metaplex
// program, so the hand-built `CreateMetadataAccountV3` encoding can only be proven against
// the live program. Run before trusting it on mainnet.
//
// What it proves:
//   - Metaplex ACCEPTS the hand-built instruction (a bad Borsh encoding makes the program
//     reject the tx, so a successful confirm already validates the layout),
//   - the metadata account round-trips: key == MetadataV1, mint + update authority match,
//     and the on-chain name / symbol equal what we sent.
//
// Usage:
//   OPENPERPS_PAYER=C:/tmp/op-devnet/id.json tsx scripts/verify-metadata-devnet.ts

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { buildTokenMetadataIx, tokenMetadataPda, TOKEN_METADATA_PROGRAM_ID } from "../src/index.ts";

const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.OPENPERPS_PAYER ?? resolve(homedir(), ".config/solana/id.json");

const NAME = "OpenPerps Launch Test";
const SYMBOL = "OPPTEST";
const URI = "https://openperps.xyz/launch-test.json";

let passes = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passes++;
  console.log(`  PASS  ${label}`);
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

// Parse one Borsh string (u32 LE length prefix + bytes). Metaplex stores the metadata
// strings padded to fixed lengths with trailing NULs, so trim them off.
function readBorshString(buf: Buffer, offset: number): { value: string; next: number } {
  const len = buf.readUInt32LE(offset);
  const raw = buf.subarray(offset + 4, offset + 4 + len);
  const value = raw.toString("utf8").replace(/\0+$/, "");
  return { value, next: offset + 4 + len };
}

async function main(): Promise<void> {
  const payer = loadKeypair(PAYER_PATH);
  const conn = new Connection(RPC, "confirmed");
  console.log(`rpc=${RPC}\nmetaplex=${TOKEN_METADATA_PROGRAM_ID.toBase58()}\npayer=${payer.publicKey.toBase58()}`);

  const metaplex = await conn.getAccountInfo(TOKEN_METADATA_PROGRAM_ID);
  if (!metaplex?.executable) {
    throw new Error("Metaplex Token Metadata program not found on this cluster (use devnet/mainnet)");
  }

  // A fresh mint, with the payer as mint authority (so it can sign the metadata create).
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log(`mint=${mint.toBase58()}`);

  const ix = buildTokenMetadataIx({
    mint,
    mintAuthority: payer.publicKey,
    payer: payer.publicKey,
    name: NAME,
    symbol: SYMBOL,
    uri: URI,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
  // A successful confirm already means Metaplex Borsh-decoded the instruction we hand-built.
  check(true, `CreateMetadataAccountV3 accepted by Metaplex (tx=${sig})`);

  // Read the account back and confirm the fields round-trip.
  const [metadataPda] = tokenMetadataPda(mint);
  const acc = await conn.getAccountInfo(metadataPda);
  check(!!acc, "metadata account exists");
  check(acc!.owner.equals(TOKEN_METADATA_PROGRAM_ID), "metadata account is owned by Metaplex");

  const data = acc!.data;
  // Layout: key(u8) | update_authority(32) | mint(32) | name(str) | symbol(str) | uri(str) | ...
  check(data[0] === 4, "key byte == 4 (MetadataV1)");
  const updateAuthority = new PublicKey(data.subarray(1, 33));
  const storedMint = new PublicKey(data.subarray(33, 65));
  check(updateAuthority.equals(payer.publicKey), "update authority == payer");
  check(storedMint.equals(mint), "stored mint == our mint");

  const nameRead = readBorshString(data, 65);
  const symbolRead = readBorshString(data, nameRead.next);
  const uriRead = readBorshString(data, symbolRead.next);
  check(nameRead.value === NAME, `name round-trips ("${nameRead.value}")`);
  check(symbolRead.value === SYMBOL, `symbol round-trips ("${symbolRead.value}")`);
  check(uriRead.value === URI, `uri round-trips ("${uriRead.value}")`);

  console.log(`\nALL METADATA CHECKS PASSED (${passes})`);
  console.log(`explorer: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
