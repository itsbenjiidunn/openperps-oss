import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFSET_CAPITAL,
  OFFSET_PNL,
  decodePortfolioSummary,
} from "../src/decoders.ts";
import { portfolioAccountSize } from "../src/layout.ts";

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

test("decodePortfolioSummary reads capital and pnl", () => {
  // Size the buffer to a real portfolio account (header + legs) so
  // decodePortfolioSummary's position decode, which reads the legs further in,
  // stays in bounds. capital and pnl sit near the front; legs do not.
  const data = new Uint8Array(portfolioAccountSize(1));
  writeU128LE(data, OFFSET_CAPITAL, 50_000_000n);
  writeU128LE(data, OFFSET_PNL, 1_000_000n);
  const summary = decodePortfolioSummary(data);
  assert.equal(summary.capital, 50_000_000n);
  assert.equal(summary.pnl, 1_000_000n);
  assert.deepEqual(summary.positions, []);
});
