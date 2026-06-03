/// Read the on-chain mark for a market's asset slot. The mark is the only price
/// that may be used as a trade's `executionPrice`; chart, Birdeye, DexScreener,
/// or any client price is for display and prefill only.

import { Connection, PublicKey } from "@solana/web3.js";
import { readU64LE, slotEffectivePriceOffset, slotLastOffset } from "./layout.ts";

export type MarketState = {
  /// The asset slot's current on-chain mark (EWMA `effective_price`), in the
  /// market's price scale. 0 if the slot has never been accrued. Use this as a
  /// trade's `executionPrice`.
  markPrice: bigint;
  /// The slot of the asset's last accrual, for freshness checks. 0 if unset.
  slotLast: number;
};

/// Fetch the on-chain `MarketState` (mark + last-accrual slot) for an asset slot
/// from its market account. Returns zeros if the account or slot is unavailable.
/// Source a trade's `executionPrice` from `markPrice`, never a client chart price.
export async function fetchMarketState(
  connection: Connection,
  market: PublicKey,
  assetIndex: number,
): Promise<MarketState> {
  const info = await connection.getAccountInfo(market);
  if (!info) return { markPrice: 0n, slotLast: 0 };
  const u = new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const markOff = slotEffectivePriceOffset(assetIndex);
  const slotLastOff = slotLastOffset(assetIndex);
  const markPrice = markOff + 8 <= u.length ? readU64LE(u, markOff) : 0n;
  const slotLast = slotLastOff + 8 <= u.length ? Number(readU64LE(u, slotLastOff)) : 0;
  return { markPrice, slotLast };
}
