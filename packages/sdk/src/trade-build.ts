/// High-level trade builder: turn a validated trade intent plus resolved market
/// state into the actual on-chain instructions. This is the bridge from the
/// SDK-format intent (see trade-resolution.ts) to a `PlaceOrder` against the
/// House/LP counterparty. Build-only: the caller wraps and signs.

import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { placeOrderIx, portfolioPda, Side } from "./instructions.ts";
import {
  resolveTradeIntent,
  type ResolveTradeInput,
  type ResolvedTrade,
} from "./trade-resolution.ts";

export type BuildTradeFromIntentInput = ResolveTradeInput & {
  /// The wallet that owns the user portfolio. Used to derive the portfolio PDA
  /// and, unless a delegate is given, to sign.
  owner: PublicKey;
  /// Per-trade fee in bps. Clamp to the market's cap at the call site; defaults
  /// to 0.
  feeBps?: bigint;
  /// A session-key delegate PDA, when a session key signs instead of the owner.
  delegate?: PublicKey;
};

export type BuiltTrade = {
  instructions: TransactionInstruction[];
  userPortfolio: PublicKey;
  resolved: ResolvedTrade;
};

/// Resolve the intent (counterparty + SDK guards) and compose the `PlaceOrder`
/// instruction against the user's portfolio PDA and the House/LP counterparty.
export function buildTradeFromIntent(input: BuildTradeFromIntentInput): BuiltTrade {
  const resolved = resolveTradeIntent(input);

  const programId = new PublicKey(input.market.programId);
  const marketAccount = new PublicKey(input.market.market);
  const [userPortfolio] = portfolioPda(programId, input.owner, marketAccount);

  const instruction = placeOrderIx({
    programId,
    market: marketAccount,
    userPortfolio,
    housePortfolio: new PublicKey(resolved.housePortfolio),
    user: input.delegate ?? input.owner,
    delegate: input.delegate,
    side: resolved.side === "long" ? Side.Long : Side.Short,
    assetIndex: input.market.assetIndex,
    sizeQ: BigInt(resolved.size),
    execPrice: resolved.executionPrice,
    feeBps: input.feeBps ?? 0n,
  });

  return { instructions: [instruction], userPortfolio, resolved };
}
