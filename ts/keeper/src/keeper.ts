/// The core multi-market keeper runner. v1 is core-only: push oracle/funding
/// updates and submit liquidations. No analytics, candles, billing, or hosted
/// registry. The runner is a simple sequential loop; OI-gated scheduling can
/// come later.

import { PublicKey, Transaction } from "@solana/web3.js";
import { liquidateIx, readU64LE, slotOffset } from "@openperps/sdk";
import { buildAccrualInstructions } from "./accrual.ts";
import type { KeeperDeps, KeeperMarket } from "./types.ts";

// `slot_last` byte offset within one engine market slot (32-byte wrapper +
// in-asset offset 41).
const SLOT_LAST_IN_SLOT = 73;

/// Read an asset slot's `slot_last` from the market account. Returns 0 if the
/// account or slot is unavailable.
export async function readSlotLast(
  deps: Pick<KeeperDeps, "connection">,
  market: PublicKey,
  assetIndex: number,
): Promise<number> {
  const info = await deps.connection.getAccountInfo(market);
  if (!info) return 0;
  const u = new Uint8Array(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const off = slotOffset(assetIndex) + SLOT_LAST_IN_SLOT;
  if (off + 8 > u.length) return 0;
  return Number(readU64LE(u, off));
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
    const [price, slotLast, nowSlot] = await Promise.all([
      deps.priceProvider.getPrice(market.config),
      readSlotLast(deps, marketAccount, market.config.assetIndex),
      deps.connection.getSlot("confirmed"),
    ]);

    const instructions = buildAccrualInstructions({
      programId,
      market: marketAccount,
      authority: deps.authority.publicKey,
      assetIndex: market.config.assetIndex,
      effectivePrice: price.price,
      slotLast,
      nowSlot,
      maxAccrualDtSlots: market.maxAccrualDtSlots,
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
    return signature;
  } catch (e) {
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
