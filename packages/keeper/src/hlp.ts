/// HLP rebalance keeper: keeps a target fraction of the House-LP vault's NAV liquid
/// in the free buffer (for redemptions) and the rest deployed in the engine House
/// (earning as the counterparty). The deploy/harvest target is an off-chain operator
/// policy, not an on-chain HLP parameter.
///
/// `rebalanceHlp` signs with `deps.authority`, which MUST be the market authority
/// (DeployHlp and HarvestHlp are authority-gated). Harvest only lands while the House
/// is flat (the engine refuses to withdraw House capital while it holds positions),
/// so the planner skips it otherwise.

import { PublicKey, Transaction } from "@solana/web3.js";
import {
  HOUSE_SEED,
  OFFSET_CAPITAL,
  OFFSET_PNL,
  VAULT_SEED,
  decodePortfolioPositions,
  deployHlpIx,
  harvestHlpIx,
  hlpVaultPda,
  readU128LE,
} from "@openperps/sdk";
import type { KeeperDeps, KeeperMarket } from "./types.ts";

export type HlpRebalanceConfig = {
  /// Target fraction of NAV to keep liquid in the buffer, in bps (e.g. 2000 = 20%).
  targetBufferBps: number;
  /// Dead-band around the target (bps of NAV) so the keeper does not churn tiny
  /// rebalances. Defaults to 0.
  hysteresisBps?: number;
  /// Skip an action below this amount (quote atoms), to avoid dust transactions.
  /// Defaults to 0.
  minActionAmount?: bigint;
};

export type HlpState = {
  /// Free buffer balance (quote atoms).
  bufferBalance: bigint;
  /// House marked equity (quote atoms), floored at 0.
  houseEquity: bigint;
  /// Whether the House holds any open position (harvest is impossible if so).
  houseHasPositions: boolean;
};

export type HlpRebalanceAction =
  | { action: "deploy"; amount: bigint }
  | { action: "harvest"; amount: bigint }
  | { action: "none"; reason: string };

/// Decide whether to deploy buffer into the House, harvest House back to the buffer,
/// or do nothing, to track `targetBufferBps` of NAV in the buffer. Pure; the engine
/// is the final arbiter of the actual deploy/harvest limit (the runner simulates
/// first). NAV = buffer + House equity.
export function planHlpRebalance(
  state: HlpState,
  config: HlpRebalanceConfig,
): HlpRebalanceAction {
  const minAmt = config.minActionAmount ?? 0n;
  const nav = state.bufferBalance + state.houseEquity;
  if (nav <= 0n) return { action: "none", reason: "empty vault" };

  const target = (nav * BigInt(config.targetBufferBps)) / 10_000n;
  const band = (nav * BigInt(config.hysteresisBps ?? 0)) / 10_000n;

  // Too much idle in the buffer, deploy the excess into the House (always allowed).
  if (state.bufferBalance > target + band) {
    const amount = state.bufferBalance - target;
    if (amount < minAmt) {
      return { action: "none", reason: "deploy below minActionAmount" };
    }
    return { action: "deploy", amount };
  }

  // Buffer too low, refill it from the House, but only while the House is flat.
  if (state.bufferBalance < target - band) {
    if (state.houseHasPositions) {
      return {
        action: "none",
        reason: "buffer low but House not flat (cannot harvest)",
      };
    }
    const want = target - state.bufferBalance;
    const amount = want < state.houseEquity ? want : state.houseEquity;
    if (amount <= 0n || amount < minAmt) {
      return {
        action: "none",
        reason: "harvest below minActionAmount or no House capital",
      };
    }
    return { action: "harvest", amount };
  }

  return { action: "none", reason: "within target band" };
}

/// Read a signed 128-bit little-endian (two's complement) integer.
function readI128LE(data: Uint8Array, offset: number): bigint {
  const raw = readU128LE(data, offset);
  return raw >= 1n << 127n ? raw - (1n << 128n) : raw;
}

/// Read the live HLP state (buffer balance, House marked equity, House positions)
/// for one market in two account fetches.
export async function readHlpState(
  deps: Pick<KeeperDeps, "connection">,
  programId: PublicKey,
  market: PublicKey,
): Promise<HlpState> {
  const [hlpVault] = hlpVaultPda(programId, market);
  const [housePda] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.toBuffer()],
    programId,
  );

  let bufferBalance = 0n;
  try {
    bufferBalance = BigInt(
      (await deps.connection.getTokenAccountBalance(hlpVault)).value.amount,
    );
  } catch {
    bufferBalance = 0n;
  }

  const houseInfo = await deps.connection.getAccountInfo(housePda);
  let houseEquity = 0n;
  let houseHasPositions = false;
  if (houseInfo) {
    const data = new Uint8Array(
      houseInfo.data.buffer,
      houseInfo.data.byteOffset,
      houseInfo.data.byteLength,
    );
    const capital = readU128LE(data, OFFSET_CAPITAL);
    const pnl = readI128LE(data, OFFSET_PNL);
    const equity = capital + pnl;
    houseEquity = equity > 0n ? equity : 0n;
    houseHasPositions = decodePortfolioPositions(data).length > 0;
  }

  return { bufferBalance, houseEquity, houseHasPositions };
}

/// Read state, plan a rebalance, and submit the deploy/harvest transaction (signed by
/// `deps.authority`, the market authority). Simulate-first, so a no-op or an action
/// the engine would reject costs no fee. Returns the action taken (with the tx
/// signature when one was sent).
export async function rebalanceHlp(
  deps: KeeperDeps,
  market: KeeperMarket,
  config: HlpRebalanceConfig,
): Promise<{ action: HlpRebalanceAction; signature: string | null }> {
  const log = deps.log ?? (() => {});
  const programId = new PublicKey(market.config.programId);
  const marketPk = new PublicKey(market.config.market);

  const state = await readHlpState(deps, programId, marketPk);
  const action = planHlpRebalance(state, config);
  if (action.action === "none") {
    log("info", `hlp ${market.config.id}: ${action.reason}`);
    return { action, signature: null };
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, marketPk.toBuffer()],
    programId,
  );
  const [hlpVault] = hlpVaultPda(programId, marketPk);
  const [housePda] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, marketPk.toBuffer()],
    programId,
  );

  const ix =
    action.action === "deploy"
      ? deployHlpIx({
          programId,
          market: marketPk,
          housePortfolio: housePda,
          vault: hlpVault,
          marketVault: vaultPda,
          authority: deps.authority.publicKey,
          amount: action.amount,
        })
      : harvestHlpIx({
          programId,
          market: marketPk,
          housePortfolio: housePda,
          marketVault: vaultPda,
          vault: hlpVault,
          authority: deps.authority.publicKey,
          amount: action.amount,
        });

  try {
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } =
      await deps.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = deps.authority.publicKey;
    tx.sign(deps.authority);
    const sim = await deps.connection.simulateTransaction(tx);
    if (sim.value.err) {
      log("info", `hlp ${market.config.id}: ${action.action} would revert, skipping`);
      return { action: { action: "none", reason: "simulation reverted" }, signature: null };
    }
    const signature = await deps.connection.sendRawTransaction(tx.serialize());
    await deps.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    log("info", `hlp ${market.config.id}: ${action.action} ${action.amount}: ${signature}`);
    return { action, signature };
  } catch (e) {
    log("error", `hlp ${market.config.id}: ${action.action} failed`, e);
    return { action: { action: "none", reason: "send failed" }, signature: null };
  }
}
