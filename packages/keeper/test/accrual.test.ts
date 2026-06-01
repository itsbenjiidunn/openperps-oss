import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import { buildAccrualInstructions } from "../src/accrual.ts";

const programId = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;

test("builds one accrual when fresh", () => {
  const ixs = buildAccrualInstructions({
    programId,
    market,
    authority,
    assetIndex: 0,
    oldMark: 0n,
    effectivePrice: 100_000_000n,
    slotLast: 100,
    nowSlot: 100,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(ixs.length, 1);
  // Structural check rather than `instanceof`: across the file: SDK boundary the
  // instruction comes from the SDK's @solana/web3.js, a distinct class identity.
  assert.equal(ixs[0]!.programId.toBase58(), programId.toBase58());
  assert.ok(Array.isArray(ixs[0]!.keys));
});

test("bursts catch-up accruals when behind", () => {
  const ixs = buildAccrualInstructions({
    programId,
    market,
    authority,
    assetIndex: 0,
    oldMark: 0n,
    effectivePrice: 100_000_000n,
    slotLast: 0,
    nowSlot: 2500,
    maxAccrualDtSlots: 1000,
    maxPriceMoveBpsPerSlot: 10,
  });
  assert.equal(ixs.length, 3);
});
