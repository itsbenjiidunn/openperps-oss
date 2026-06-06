import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { OFFSET_PORTFOLIO_LEGS, PORTFOLIO_HEADER_SIZE } from "@openperps/sdk";
import { selectLiquidatable } from "../src/keeper.ts";

// In-leg byte offsets, mirroring packages/sdk/src/layout.ts. Leg 0 starts at
// OFFSET_PORTFOLIO_LEGS; `basis_pos_q` is the signed position size.
const LEG_ACTIVE = 0;
const LEG_ASSET_INDEX = 1;
const LEG_SIDE = 13;
const LEG_BASIS_POS_Q = 14;

/// Build a portfolio account buffer with one active leg in `assetIndex`.
function withPosition(assetIndex: number, sizeQ: bigint): Uint8Array {
  const data = new Uint8Array(PORTFOLIO_HEADER_SIZE);
  const base = OFFSET_PORTFOLIO_LEGS;
  data[base + LEG_ACTIVE] = 1;
  data[base + LEG_ASSET_INDEX] = assetIndex & 0xff;
  data[base + LEG_ASSET_INDEX + 1] = (assetIndex >> 8) & 0xff;
  data[base + LEG_ASSET_INDEX + 2] = (assetIndex >> 16) & 0xff;
  data[base + LEG_ASSET_INDEX + 3] = (assetIndex >> 24) & 0xff;
  data[base + LEG_SIDE] = 0;
  let v = sizeQ;
  for (let i = 0; i < 16; i++) {
    data[base + LEG_BASIS_POS_Q + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return data;
}

const flat = (): Uint8Array => new Uint8Array(PORTFOLIO_HEADER_SIZE);

test("selectLiquidatable keeps positioned accounts in the asset, skips flat, wrong-asset, and the House", () => {
  const house = PublicKey.unique();
  const positioned = PublicKey.unique();
  const empty = PublicKey.unique();
  const wrongAsset = PublicKey.unique();

  const accounts = [
    { pubkey: positioned, data: withPosition(0, 1_000_000n) },
    { pubkey: empty, data: flat() },
    { pubkey: wrongAsset, data: withPosition(1, 1_000_000n) },
    // The House holds a position in the asset but must never be a candidate.
    { pubkey: house, data: withPosition(0, 1_000_000n) },
  ];

  const got = selectLiquidatable(accounts, 0, house).map((p) => p.toBase58());
  assert.deepEqual(got, [positioned.toBase58()]);
});
