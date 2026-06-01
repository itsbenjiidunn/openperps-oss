import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, Transaction } from "@solana/web3.js";

import { createOpenPerpsActions } from "../src/actions.ts";

test("createOpenPerpsActions exposes connection-bound helpers", () => {
  const actions = createOpenPerpsActions({
    connection: {
      sendTransaction: async () => "sig",
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  });
  assert.equal(typeof actions.sendTransaction, "function");
});

test("sendTransaction signs and sends a transaction", async () => {
  let sent = false;
  const actions = createOpenPerpsActions({
    connection: {
      sendTransaction: async () => {
        sent = true;
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  });
  const sig = await actions.sendTransaction(new Transaction(), [Keypair.generate()]);
  assert.equal(sig, "sig");
  assert.equal(sent, true);
});
