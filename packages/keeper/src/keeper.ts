/// The core multi-market keeper runner. v1 is core-only: push oracle/funding
/// updates and submit liquidations. No analytics, candles, billing, or hosted
/// registry. The runner is a simple sequential loop; OI-gated scheduling can
/// come later.

import { PublicKey, Transaction } from "@solana/web3.js";
import {
  liquidateIx,
  oracleAuthorityPda,
  readU64LE,
  slotEffectivePriceOffset,
  slotOffset,
} from "@openperps/sdk";
import { buildAccrualInstructions } from "./accrual.ts";
import {
  isMarketStale,
  marketBehind,
  recordCrankError,
  recordCrankOk,
  recordLiquidations,
} from "./health.ts";
import type { KeeperDeps, KeeperMarket } from "./types.ts";

// `slot_last` byte offset within one engine market slot (32-byte wrapper +
// in-asset offset 41).
const SLOT_LAST_IN_SLOT = 73;

/// One asset slot's freshness and price state, read from the market account in a
/// single fetch.
export type SlotState = {
  /// The slot of the asset's last accrual (0 if unavailable).
  slotLast: number;
  /// The asset's current EWMA mark (`effective_price`); 0 if never accrued or
  /// unavailable. Used to bound each catch-up step's price move.
  mark: bigint;
};

/// Read an asset slot's `slot_last` and current mark from the market account in
/// one fetch. Returns zeros if the account or slot is unavailable.
export async function readSlotState(
  deps: Pick<KeeperDeps, "connection">,
  market: PublicKey,
  assetIndex: number,
): Promise<SlotState> {
  const info = await deps.connection.getAccountInfo(market);
  if (!info) return { slotLast: 0, mark: 0n };
  const u = new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const slotLastOff = slotOffset(assetIndex) + SLOT_LAST_IN_SLOT;
  const markOff = slotEffectivePriceOffset(assetIndex);
  const slotLast = slotLastOff + 8 <= u.length ? Number(readU64LE(u, slotLastOff)) : 0;
  const mark = markOff + 8 <= u.length ? readU64LE(u, markOff) : 0n;
  return { slotLast, mark };
}

/// Read an asset slot's `slot_last` from the market account. Returns 0 if the
/// account or slot is unavailable.
export async function readSlotLast(
  deps: Pick<KeeperDeps, "connection">,
  market: PublicKey,
  assetIndex: number,
): Promise<number> {
  return (await readSlotState(deps, market, assetIndex)).slotLast;
}

/// Push one oracle/funding update for a market, bursting catch-up accruals if it
/// has fallen behind. Returns the signature, or null on error (logged).
export async function crankMarketOnce(
  deps: KeeperDeps,
  market: KeeperMarket,
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  const programId = new PublicKey(market.config.programId);
  const marketAccount = new PublicKey(market.config.market);
  try {
    const [price, slot, nowSlot] = await Promise.all([
      deps.priceProvider.getPrice(market.config),
      readSlotState(deps, marketAccount, market.config.assetIndex),
      deps.connection.getSlot("confirmed"),
    ]);

    const behindSlots = marketBehind(slot.slotLast, nowSlot);
    const stale = isMarketStale(behindSlots, market.maxAccrualDtSlots);
    if (stale) {
      log(
        "error",
        `crank ${market.config.id}: stale, ${behindSlots} slots behind (> ${market.maxAccrualDtSlots})`,
      );
    }

    const oracleAuthority = market.useOracleAuthorityPda
      ? oracleAuthorityPda(programId, marketAccount)[0]
      : undefined;

    const instructions = buildAccrualInstructions({
      programId,
      market: marketAccount,
      authority: deps.authority.publicKey,
      assetIndex: market.config.assetIndex,
      oldMark: slot.mark,
      effectivePrice: price.price,
      slotLast: slot.slotLast,
      nowSlot,
      maxAccrualDtSlots: market.maxAccrualDtSlots,
      maxPriceMoveBpsPerSlot: market.maxPriceMoveBpsPerSlot,
      oracleAuthority,
    });

    const tx = new Transaction().add(...instructions);
    const { blockhash, lastValidBlockHeight } =
      await deps.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = deps.authority.publicKey;
    tx.sign(deps.authority);
    const signature = await deps.connection.sendRawTransaction(tx.serialize());
    await deps.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    log(
      "info",
      `crank ${market.config.id}: ${signature} (price ${price.price}, ${instructions.length} accrual(s))`,
    );
    if (deps.health) {
      recordCrankOk(deps.health, market.config.id, {
        slotLast: slot.slotLast,
        behindSlots,
        stale,
        signature,
        accruals: instructions.length,
      });
    }
    return signature;
  } catch (e) {
    if (deps.health) recordCrankError(deps.health, market.config.id, e);
    log("error", `crank ${market.config.id} failed`, e);
    return null;
  }
}

/// Submit a permissionless `Liquidate` for a candidate portfolio. The engine
/// rejects a healthy account (NonProgress), so it is safe to attempt. Candidate
/// discovery (which portfolios are unhealthy) is integrator-provided in v1.
export async function liquidatePortfolio(
  deps: KeeperDeps,
  market: KeeperMarket,
  portfolio: PublicKey,
  args: { closeQ: bigint; feeBps?: bigint },
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  try {
    const ix = liquidateIx({
      programId: new PublicKey(market.config.programId),
      market: new PublicKey(market.config.market),
      portfolio,
      liquidator: deps.authority.publicKey,
      assetIndex: market.config.assetIndex,
      closeQ: args.closeQ,
      feeBps: args.feeBps ?? 0n,
    });
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } =
      await deps.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = deps.authority.publicKey;
    tx.sign(deps.authority);
    const signature = await deps.connection.sendRawTransaction(tx.serialize());
    await deps.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    log("info", `liquidate ${market.config.id} ${portfolio.toBase58()}: ${signature}`);
    return signature;
  } catch (e) {
    log("error", `liquidate ${market.config.id} ${portfolio.toBase58()} failed`, e);
    return null;
  }
}

/// Attempt a permissionless `Liquidate` for each candidate portfolio. The engine
/// rejects healthy accounts (NonProgress), so attempting all candidates is safe.
/// Candidate discovery is integrator-provided. Returns the signatures that
/// landed, and records the count against `deps.health` when present.
export async function scanLiquidations(
  deps: KeeperDeps,
  market: KeeperMarket,
  candidates: PublicKey[],
  args: { closeQ: bigint; feeBps?: bigint },
): Promise<string[]> {
  const signatures: string[] = [];
  for (const portfolio of candidates) {
    const sig = await liquidatePortfolio(deps, market, portfolio, args);
    if (sig) signatures.push(sig);
  }
  if (deps.health && signatures.length > 0) {
    recordLiquidations(deps.health, signatures.length);
  }
  return signatures;
}

export type RunKeeperOptions = {
  intervalMs?: number;
  signal?: AbortSignal;
};

/// Run the sequential multi-market crank loop until aborted.
export async function runKeeper(
  deps: KeeperDeps,
  markets: KeeperMarket[],
  options: RunKeeperOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  const log = deps.log ?? (() => {});
  log("info", `keeper starting: ${markets.length} market(s), interval ${intervalMs}ms`);
  while (!options.signal?.aborted) {
    for (const market of markets) {
      if (options.signal?.aborted) break;
      await crankMarketOnce(deps, market);
    }
    if (options.signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  log("info", "keeper stopped");
}
