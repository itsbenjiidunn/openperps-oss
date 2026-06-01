import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, Transaction } from "@solana/web3.js";

import { transactionFromInstructions } from "../src/transactions.ts";

test("transactionFromInstructions wraps instructions in a Transaction", () => {
  const tx = transactionFromInstructions([]);
  assert.ok(tx instanceof Transaction);
  assert.equal(tx.instructions.length, 0);
});

test("transactionFromInstructions assigns fee payer when provided", () => {
  const payer = PublicKey.default;
  const tx = transactionFromInstructions([], { feePayer: payer });
  assert.equal(tx.feePayer?.toBase58(), payer.toBase58());
});
