/// One-off: deploy the shared devnet mock-USDC mint for OpenPerps.
///
/// All markets quote against this single mint so a trader funds their
/// wallet once (via the in-app Faucet) and trades every market. The mint
/// authority is a throwaway keypair we bake into the frontend so the
/// faucet can sign MintTo, worthless on devnet, never holds SOL.
///
/// Run once:  tsx scripts/create-musdc.ts <payer-keypair.json>
/// Prints the mint address + the authority secret to paste into the app.

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

const RPC = process.env.OPENPERPS_RPC ?? "https://api.devnet.solana.com";

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const payerPath = process.argv[2];
  if (!payerPath) throw new Error("usage: tsx create-musdc.ts <payer.json>");

  const connection = new Connection(RPC, "confirmed");
  const payer = loadKeypair(payerPath);
  const mint = Keypair.generate();
  const authority = Keypair.generate();

  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const tx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: rent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
    )
    .add(
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        authority.publicKey,
        null,
      ),
    );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mint);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  console.log(JSON.stringify(
    {
      rpc: RPC,
      mint: mint.publicKey.toBase58(),
      mintAuthorityPubkey: authority.publicKey.toBase58(),
      mintAuthoritySecret: Array.from(authority.secretKey),
      signature: sig,
    },
    null,
    2,
  ));
  // sanity: confirm the mint decodes
  const info = await connection.getAccountInfo(mint.publicKey);
  if (!info || info.owner.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error("mint account did not initialize as a Token mint");
  }
  console.log("OK mint owner =", new PublicKey(info.owner).toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
