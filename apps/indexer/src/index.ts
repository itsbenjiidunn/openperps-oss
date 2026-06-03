/// OpenPerps indexer, a Cloudflare Worker that polls the program's recent
/// transactions on a cron, parses PlaceOrder fills, and stores them in D1 so
/// the frontend can show a real (global) trade feed plus 24h volume / open
/// interest / fees. State that needs per-account history (equity curve,
/// realized PnL) is out of v1.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export interface Env {
  DB: D1Database;
  RPC_URL: string;
  PROGRAM_ID: string;
  /// Funded keypair (JSON secret-key array) that signs AccrueAsset price
  /// pushes. Devnet-only; AccrueAsset is permissionless on devnet.
  RELAYER_SECRET: string;
  /// Mainnet RPC (Helius key) for the price-feed DO, pool reserves + SOL price.
  MAINNET_RPC: string;
  /// Shared realtime price feed: one Helius WS per token, fanned out to clients.
  PRICE_FEED: DurableObjectNamespace;
  /// Optional Discord-style webhook ({content}) for solvency / bad-debt alerts.
  ALERT_WEBHOOK?: string;
}

export { PriceFeed } from "./priceFeed";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PLACE_ORDER_TAG = 14;
const ACCRUE_ASSET_TAG = 4;
const ACTIVATE_MARKET_TAG = 3;
const LIQUIDATE_TAG = 8;

// Market-account layout (mirror ts/sdk/src/layout.ts) so the relayer can read
// each asset slot's `slot_last` and keep it caught up to the chain's current
// slot. The percolator engine raises a group-wide stale-loss lock (blocking
// new positions with LockActive) whenever a slot that has open interest lags
// the current slot, and one AccrueAsset only advances slot_last by at most
// `max_accrual_dt_slots`, so a single push per cron tick can't keep up.
const WRAPPER_HEADER_SIZE = 208;
const MARKET_HEADER_SIZE = 638;
const MARKET_SLOT_SIZE = 1317;
// asset.slot_last = 32-byte slot wrapper + market_id(8) + retired_slot(8)
// + lifecycle(1) + raw_oracle_target_price(8) + effective_price(8)
// + fund_px_last(8) = in-slot offset 73.
const SLOT_LAST_IN_SLOT = 73;
// effective_price within an asset slot: 32-byte slot wrapper + market_id(8)
// + retired_slot(8) + lifecycle(1) + raw_oracle_target_price(8) = in-slot 57.
const SLOT_EFF_PRICE_IN_SLOT = 57;
// Engine config `max_accrual_dt_slots` (each AccrueAsset advances at most this).
// Raised to 1000 alongside the program upgrade so one push per cron run fully
// catches slot_last up to now_slot (~150 devnet slots elapse per minute).
const MAX_ACCRUAL_DT = 1000;

function slotLastOffset(assetIndex: number): number {
  return (
    WRAPPER_HEADER_SIZE +
    MARKET_HEADER_SIZE +
    assetIndex * MARKET_SLOT_SIZE +
    SLOT_LAST_IN_SLOT
  );
}
const POS_SCALE = 1_000_000; // 6 decimals
const MAX_PER_TICK = 80;
// The single shared market group (bootstrap-shared-group.ts).
const SHARED_MARKET = "EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE";
const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const JUP = "https://api.jup.ag/price/v2";

// ---------- base58 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58.length; i++) map[B58[i]!] = i;
  const bytes: number[] = [0];
  for (const c of s) {
    let carry = map[c];
    if (carry === undefined) return new Uint8Array();
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function readUintLE(b: Uint8Array, off: number, len: number): bigint {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i] ?? 0);
  return v;
}

function readIntLE(b: Uint8Array, off: number, len: number): bigint {
  const u = readUintLE(b, off, len);
  const bits = BigInt(len * 8);
  return u & (1n << (bits - 1n)) ? u - (1n << bits) : u;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Portfolio account offsets (verified via the byte-sizes test).
const OFFSET_CAPITAL = 132;
const OFFSET_PNL = 148;
// Engine market-header `c_tot` (total user capital backing the group), used by
// the solvency monitor: WRAPPER_HEADER_SIZE(208) + ENGINE_OFFSET_C_TOT(317).
const OFFSET_C_TOT = 525;

// ---------- RPC ----------
async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result as T;
}

type SigInfo = { signature: string; err: unknown; blockTime?: number | null };

// ---------- poll + parse ----------
async function poll(env: Env): Promise<number> {
  const program = env.PROGRAM_ID;
  const cur = await env.DB.prepare("SELECT last_sig FROM cursor WHERE id = 1")
    .first<{ last_sig: string | null }>();
  const lastSig = cur?.last_sig ?? null;

  // Newest-first; stop at the cursor.
  const sigs = await rpc<SigInfo[]>(env, "getSignaturesForAddress", [
    program,
    { limit: MAX_PER_TICK },
  ]);
  if (!sigs.length) return 0;

  const fresh: SigInfo[] = [];
  for (const s of sigs) {
    if (s.signature === lastSig) break;
    fresh.push(s);
  }
  if (!fresh.length) return 0;

  // Process oldest-first so the cursor advances monotonically.
  fresh.reverse();
  let inserted = 0;
  for (const s of fresh) {
    if (s.err) continue;
    try {
      const trade = await parseTrade(env, s);
      if (trade) {
        await upsertTrade(env, trade);
        inserted++;
      }
    } catch {
      /* skip unparseable tx */
    }
  }

  const newest = sigs[0]!.signature;
  await env.DB.prepare(
    "INSERT INTO cursor (id, last_sig) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_sig = ?",
  )
    .bind(newest, newest)
    .run();
  return inserted;
}

async function upsertTrade(env: Env, t: ParsedTrade): Promise<void> {
  // Upsert (not INSERT OR IGNORE) so re-scans backfill the portfolio column
  // for rows inserted before v2.
  await env.DB.prepare(
    `INSERT INTO trades
     (signature, block_time, market, asset_index, side, size_q, exec_price, fee_bps, trader, portfolio)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(signature) DO UPDATE SET portfolio = excluded.portfolio`,
  )
    .bind(
      t.signature,
      t.blockTime,
      t.market,
      t.assetIndex,
      t.side,
      t.sizeQ,
      t.execPrice,
      t.feeBps,
      t.trader,
      t.portfolio,
    )
    .run();
}

/// Re-scan the latest `limit` signatures regardless of cursor and upsert,
/// used once to backfill the portfolio column on pre-v2 rows.
async function backfill(env: Env, limit: number): Promise<number> {
  const sigs = await rpc<SigInfo[]>(env, "getSignaturesForAddress", [
    env.PROGRAM_ID,
    { limit },
  ]);
  let n = 0;
  for (const s of sigs) {
    if (s.err) continue;
    try {
      const trade = await parseTrade(env, s);
      if (trade) {
        await upsertTrade(env, trade);
        n++;
      }
    } catch {
      /* skip */
    }
  }
  return n;
}

/// Snapshot the equity (capital + realized pnl) of every portfolio that has
/// traded. One row per portfolio per minute (PK dedups within a minute).
async function snapshotEquity(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT portfolio FROM trades WHERE portfolio != ''",
  ).all<{ portfolio: string }>();
  const pks = (results ?? []).map((r) => r.portfolio);
  if (!pks.length) return 0;
  const ts = Math.floor(Date.now() / 60000) * 60;

  let written = 0;
  // getMultipleAccounts is capped at 100 keys per call.
  for (let i = 0; i < pks.length; i += 100) {
    const batch = pks.slice(i, i + 100);
    const res = await rpc<{ value: ({ data: [string, string] } | null)[] }>(
      env,
      "getMultipleAccounts",
      [batch, { encoding: "base64" }],
    );
    for (let j = 0; j < batch.length; j++) {
      const acc = res.value[j];
      if (!acc?.data) continue;
      const bytes = b64ToBytes(acc.data[0]);
      if (bytes.length < OFFSET_PNL + 16) continue;
      const capital = readUintLE(bytes, OFFSET_CAPITAL, 16).toString();
      const pnl = readIntLE(bytes, OFFSET_PNL, 16).toString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO equity_snapshots (portfolio, ts, capital, pnl) VALUES (?,?,?,?)",
      )
        .bind(batch[j], ts, capital, pnl)
        .run();
      written++;
    }
  }
  return written;
}

type ParsedTrade = {
  signature: string;
  blockTime: number;
  market: string;
  assetIndex: number;
  side: number;
  sizeQ: string;
  execPrice: string;
  feeBps: number;
  trader: string;
  portfolio: string;
};

async function parseTrade(env: Env, s: SigInfo): Promise<ParsedTrade | null> {
  const tx = await rpc<any>(env, "getTransaction", [
    s.signature,
    { encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx?.transaction?.message) return null;
  const msg = tx.transaction.message;
  const keys: string[] = msg.accountKeys ?? [];
  const ixs: { programIdIndex: number; accounts: number[]; data: string }[] =
    msg.instructions ?? [];
  for (const ix of ixs) {
    if (keys[ix.programIdIndex] !== env.PROGRAM_ID) continue;
    const data = b58decode(ix.data);
    if (data.length < 38 || data[0] !== PLACE_ORDER_TAG) continue;
    // tag(1) side(1) asset_index(4) size_q(16) exec_price(8) fee_bps(8)
    const side = data[1]!;
    const assetIndex = Number(readUintLE(data, 2, 4));
    const sizeQ = readUintLE(data, 6, 16).toString();
    const execPrice = readUintLE(data, 22, 8).toString();
    const feeBps = Number(readUintLE(data, 30, 8));
    // accounts: [market, user_portfolio, house, user]
    const market = keys[ix.accounts[0]!] ?? "";
    const portfolio = keys[ix.accounts[1]!] ?? "";
    const trader = keys[ix.accounts[3]!] ?? "";
    return {
      signature: s.signature,
      blockTime: tx.blockTime ?? s.blockTime ?? Math.floor(Date.now() / 1000),
      market,
      assetIndex,
      side,
      sizeQ,
      execPrice,
      feeBps,
      trader,
      portfolio,
    };
  }
  return null;
}

// ---------- HTTP API ----------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...CORS },
  });
}

/// Replay an owner's fills into a net position per (market, asset slot) with a
/// volume-weighted average entry price. Increasing the position blends the
/// entry; reducing keeps it; flipping resets to the fill price. Keying by
/// `market:asset_index` (not asset slot alone) is essential: every custom
/// isolated market uses slot 0, so without the market they all collide into one
/// bogus blended position (and a major at slot 0 would mix in too).
function computePositions(
  rows: { market: string; asset_index: number; side: number; size_q: string; exec_price: string }[],
): { market: string; assetIndex: number; side: number; size: number; entry: number }[] {
  const byKey = new Map<string, { pos: number; entry: number; market: string; assetIndex: number }>();
  for (const r of rows) {
    const price = Number(r.exec_price) / POS_SCALE;
    const signed = (r.side === 0 ? 1 : -1) * (Number(r.size_q) / POS_SCALE);
    const key = `${r.market}:${r.asset_index}`;
    const cur = byKey.get(key) ?? { pos: 0, entry: 0, market: r.market, assetIndex: r.asset_index };
    const pos = cur.pos;
    if (pos === 0 || Math.sign(pos) === Math.sign(signed)) {
      const newAbs = Math.abs(pos) + Math.abs(signed);
      cur.entry = newAbs > 0 ? (Math.abs(pos) * cur.entry + Math.abs(signed) * price) / newAbs : 0;
      cur.pos = pos + signed;
    } else if (Math.abs(signed) < Math.abs(pos)) {
      cur.pos = pos + signed; // partial close, entry unchanged
    } else {
      const rem = Math.abs(signed) - Math.abs(pos);
      cur.pos = Math.sign(signed) * rem;
      cur.entry = rem > 0 ? price : 0;
    }
    byKey.set(key, cur);
  }
  const out: { market: string; assetIndex: number; side: number; size: number; entry: number }[] = [];
  for (const v of byKey.values()) {
    if (Math.abs(v.pos) < 1e-9) continue;
    out.push({
      market: v.market,
      assetIndex: v.assetIndex,
      side: v.pos > 0 ? 0 : 1,
      size: Math.abs(v.pos),
      entry: v.entry,
    });
  }
  return out;
}

function rowToTrade(r: any) {
  const size = Number(r.size_q) / POS_SCALE;
  const price = Number(r.exec_price) / POS_SCALE;
  return {
    signature: r.signature,
    ts: r.block_time * 1000,
    market: r.market,
    assetIndex: r.asset_index,
    side: r.side, // 0 long, 1 short
    size,
    price,
    notional: size * price,
    feeBps: r.fee_bps,
    trader: r.trader,
  };
}

// ---------- price relayer (devnet "live market data") ----------

async function pythPrice(feedId: string): Promise<number | null> {
  try {
    const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    const res = await fetch(`${HERMES}?ids[]=${id}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      parsed?: { price?: { price?: string; expo?: number } }[];
    };
    const p = j.parsed?.[0]?.price;
    if (!p?.price || p.expo === undefined) return null;
    const v = Number(p.price) * 10 ** p.expo;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function jupPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUP}?ids=${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: Record<string, { price?: string | number }>;
    };
    const raw = j.data?.[mint]?.price;
    const v = typeof raw === "string" ? Number(raw) : raw;
    return v && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const GECKO_TOKEN_PRICE =
  "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price";

/// GeckoTerminal USD price for a mint (covers pump / long-tail SPL that Jupiter
/// doesn't price). Null on failure.
async function geckoPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${GECKO_TOKEN_PRICE}/${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: { attributes?: { token_prices?: Record<string, string> } };
    };
    const prices = j.data?.attributes?.token_prices ?? {};
    const raw = prices[mint] ?? Object.values(prices)[0];
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// DexScreener USD price for a mint, the broadest memecoin coverage and far
/// less rate-limited than GeckoTerminal's free tier (which 429s the Worker's
/// shared egress IP, leaving the mark frozen while the UI's Spot, also
/// DexScreener, keeps moving). Deepest Solana pair. Null on failure.
async function dexScreenerPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      pairs?: { chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }[];
    };
    const p = (j.pairs ?? [])
      .filter((x) => x.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const v = Number(p?.priceUsd);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// Live mainnet price for a custom market's token. DexScreener first (so the
/// engine mark converges to the same price the UI Spot shows), then
/// GeckoTerminal, then Jupiter.
async function tokenPrice(mint: string): Promise<number | null> {
  return (
    (await dexScreenerPrice(mint)) ?? (await geckoPrice(mint)) ?? (await jupPrice(mint))
  );
}

/// Top Solana pair's liquidity (USD) for a token, or `null` when there's no
/// pair / the lookup failed, so we NEVER delist on a missing reading, only on a
/// real low number.
async function dexScreenerLiquidity(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      pairs?: { chainId?: string; liquidity?: { usd?: number } }[];
    };
    const p = (j.pairs ?? [])
      .filter((x) => x.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!p || p.liquidity?.usd == null) return null;
    const v = Number(p.liquidity.usd);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/// Auto-delist custom markets whose token liquidity has collapsed below
/// `DELIST_LIQUIDITY_USD`. A drained / rugged pool can no longer be priced or
/// traded safely, so we drop it from `custom_markets` (the UI stops listing it;
/// the on-chain account is left untouched). Launch needs >$25k, delist <$3k, a
/// wide hysteresis so a market never flaps around one threshold. Only a REAL
/// reading triggers it; a missing/failed liquidity lookup is skipped.
const DELIST_LIQUIDITY_USD = 3_000;
async function pruneIlliquidMarkets(env: Env): Promise<{ removed: string[] }> {
  const { results } = await env.DB.prepare(
    "SELECT pubkey, symbol, base_mint FROM custom_markets WHERE base_mint IS NOT NULL",
  ).all<{ pubkey: string; symbol: string; base_mint: string }>();
  const removed: string[] = [];
  for (const m of results ?? []) {
    const liq = await dexScreenerLiquidity(m.base_mint);
    if (liq === null) continue; // unknown liquidity, never delist on no reading
    if (liq < DELIST_LIQUIDITY_USD) {
      await env.DB.prepare("DELETE FROM custom_markets WHERE pubkey = ?")
        .bind(m.pubkey)
        .run();
      removed.push(`${m.symbol} ($${Math.round(liq)} LP)`);
    }
  }
  if (removed.length && env.ALERT_WEBHOOK) {
    try {
      await fetch(env.ALERT_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `**OpenPerps auto-delist** (LP < $${DELIST_LIQUIDITY_USD.toLocaleString()})\n${removed.join("\n")}`,
        }),
      });
    } catch {
      /* best-effort */
    }
  }
  return { removed };
}

function accrueAssetIxData(assetIndex: number, priceAtoms: bigint): Buffer {
  const d = new Uint8Array(29);
  d[0] = ACCRUE_ASSET_TAG;
  // asset_index u32 LE @1
  d[1] = assetIndex & 0xff;
  d[2] = (assetIndex >> 8) & 0xff;
  d[3] = (assetIndex >> 16) & 0xff;
  d[4] = (assetIndex >> 24) & 0xff;
  // effective_price u64 LE @5
  let v = priceAtoms;
  for (let i = 0; i < 8; i++) {
    d[5 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  // funding_rate_e9 i128 @13 = 0
  return Buffer.from(d);
}

// Liquidate ix data: tag(1) asset_index(u32 @1) close_q(u128 @5) fee_bps(u64 @21).
function liquidateIxData(assetIndex: number, closeQ: bigint, feeBps: bigint): Buffer {
  const d = new Uint8Array(1 + 4 + 16 + 8);
  d[0] = LIQUIDATE_TAG;
  d[1] = assetIndex & 0xff;
  d[2] = (assetIndex >> 8) & 0xff;
  d[3] = (assetIndex >> 16) & 0xff;
  d[4] = (assetIndex >> 24) & 0xff;
  let c = closeQ;
  for (let i = 0; i < 16; i++) {
    d[5 + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  let f = feeBps;
  for (let i = 0; i < 8; i++) {
    d[21 + i] = Number(f & 0xffn);
    f >>= 8n;
  }
  return Buffer.from(d);
}

function activateMarketIxData(assetIndex: number, priceAtoms: bigint): Buffer {
  const d = new Uint8Array(1 + 4 + 8);
  d[0] = ACTIVATE_MARKET_TAG;
  d[1] = assetIndex & 0xff;
  d[2] = (assetIndex >> 8) & 0xff;
  d[3] = (assetIndex >> 16) & 0xff;
  d[4] = (assetIndex >> 24) & 0xff;
  let v = priceAtoms;
  for (let i = 0; i < 8; i++) {
    d[5 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return Buffer.from(d);
}

/// Activate a fresh asset slot at a seed price, signed by the (funded) relayer
/// key. ActivateMarket is permissionless on devnet. Used to bootstrap official
/// markets (ETH/JUP) so the relayer can then push live prices to them.
async function activateSlot(
  env: Env,
  assetIndex: number,
  priceAtoms: bigint,
): Promise<string> {
  const relayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env.RELAYER_SECRET) as number[]),
  );
  const conn = new Connection(env.RPC_URL, "confirmed");
  const ix = new TransactionInstruction({
    programId: new PublicKey(env.PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(SHARED_MARKET), isSigner: false, isWritable: true },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
    ],
    data: activateMarketIxData(assetIndex, priceAtoms),
  });
  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = relayer.publicKey;
  tx.sign(relayer);
  return conn.sendRawTransaction(tx.serialize());
}

/// Send one confirmed AccrueAsset for `assetIndex` at `priceAtoms`. Returns the
/// signature, or null on failure. Confirmed (not fire-and-forget) so that a
/// caller can chain several to advance `slot_last` step by step, each accrual
/// reads the previous one's updated state.
async function accrueOnce(
  conn: Connection,
  relayer: Keypair,
  program: PublicKey,
  market: PublicKey,
  assetIndex: number,
  priceAtoms: bigint,
): Promise<string | null> {
  try {
    const ix = new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
      ],
      data: accrueAssetIxData(assetIndex, priceAtoms),
    });
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = relayer.publicKey;
    tx.sign(relayer);
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  } catch {
    return null;
  }
}

/// Push real market prices on-chain AND keep each asset's `slot_last` caught up
/// to the chain's current slot. For every registered market we fetch the live
/// USD price (Pyth, then Jupiter) and send up to `maxStepsPerAsset` confirmed
/// AccrueAsset calls, enough to advance `slot_last` past the elapsed slots so
/// the engine's stale-loss lock never trips. `maxStepsPerAsset` is small for
/// the 1-min cron (keep-up) and large for the manual /catchup burst (clear a
/// backlog). Returns the number of accruals landed.
async function relayPrices(env: Env, maxStepsPerAsset = 3): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT asset_index, pyth_feed_id, base_mint FROM markets",
  ).all<{ asset_index: number; pyth_feed_id: string | null; base_mint: string | null }>();
  if (!results?.length) return 0;

  const relayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env.RELAYER_SECRET) as number[]),
  );
  const conn = new Connection(env.RPC_URL, "confirmed");
  const program = new PublicKey(env.PROGRAM_ID);
  const market = new PublicKey(SHARED_MARKET);

  const nowSlot = await conn.getSlot("confirmed");
  const acct = await conn.getAccountInfo(market);
  const data = acct?.data ?? null;

  let pushed = 0;
  for (const m of results) {
    let usd: number | null = null;
    if (m.pyth_feed_id) usd = await pythPrice(m.pyth_feed_id);
    if (usd === null && m.base_mint) usd = await jupPrice(m.base_mint);
    if (usd === null || usd <= 0) continue;
    const priceAtoms = BigInt(Math.round(usd * POS_SCALE));
    if (priceAtoms <= 0n) continue;

    // How many accruals to keep this slot fresh: ceil(behind / max_dt), plus
    // one for the elapsed time since, capped at maxStepsPerAsset.
    let steps = 1;
    if (data) {
      const off = slotLastOffset(m.asset_index);
      if (off + 8 <= data.length) {
        const slotLast = Number(data.readBigUInt64LE(off));
        const behind = Math.max(0, nowSlot - slotLast);
        steps = Math.min(Math.ceil(behind / MAX_ACCRUAL_DT) + 1, maxStepsPerAsset);
      }
    }
    for (let k = 0; k < Math.max(1, steps); k++) {
      const sig = await accrueOnce(conn, relayer, program, market, m.asset_index, priceAtoms);
      if (sig) pushed++;
      else break; // stop bursting this asset if one fails
    }
  }
  return pushed;
}

/// Map a custom_markets row back to the frontend's RegistryEntry shape so the
/// browser can render + trade the launch without any local state.
function rowToCustomMarket(r: any) {
  return {
    pubkey: r.pubkey,
    symbol: r.symbol,
    base: r.base,
    quoteMint: r.quote_mint ?? undefined,
    vault: r.vault ?? undefined,
    assetSlotCapacity: r.asset_slot_capacity ?? 0,
    assetIndex: r.asset_index ?? 0,
    baseMint: r.base_mint ?? undefined,
    oracleKind: r.oracle_kind ?? undefined,
    oraclePool: r.oracle_pool ?? undefined,
    maxLeverage: r.max_leverage ?? undefined,
    feeBps: r.fee_bps ?? undefined,
    seedPriceUsd: r.seed_price_usd ?? undefined,
    house: r.house ?? undefined,
    houseBump: r.house_bump ?? undefined,
    ownGroup: !!r.own_group,
    seedLp: r.seed_lp ?? undefined,
    addedAt: (r.created_at ?? 0) * 1000,
  };
}

/// Keep launched custom markets' marks fresh too, not just the shared majors.
/// Each launch is its own group account, so we accrue against its own pubkey
/// at its asset slot. Manual-oracle markets only (dex-pinned markets take their
/// mark from the pinned pool); a real price needs the token to be on Jupiter.
/// Best-effort, a missing price source or stale account just skips that one.
// Engine's per-slot price-move cap (default_market_config.max_price_move_bps_per_slot).
const MAX_MOVE_BPS_PER_SLOT = 10;

async function relayCustomPrices(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT pubkey, asset_index, base_mint FROM custom_markets",
  ).all<{ pubkey: string; asset_index: number; base_mint: string | null }>();
  if (!results?.length) return 0;

  const relayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env.RELAYER_SECRET) as number[]),
  );
  const conn = new Connection(env.RPC_URL, "confirmed");
  const program = new PublicKey(env.PROGRAM_ID);
  const nowSlot = await conn.getSlot("confirmed");

  let pushed = 0;
  for (const m of results) {
    // A custom market lists a real MAINNET token, so we converge its on-chain
    // mark to that token's live Jupiter price, you trade real mainnet price
    // action against the devnet House. Each push moves the mark toward the live
    // price but CLAMPED to the engine's per-slot move cap (10 bps/slot * slots
    // advanced) so the accrual never exceeds the envelope and reverts. With the
    // cron running every minute (~150 slots, ~15% room) it tracks closely; if
    // Jupiter has no price we re-assert the current mark (delta-0) to stay fresh.
    const market = new PublicKey(m.pubkey);
    const acct = await conn.getAccountInfo(market);
    const data = acct?.data ?? null;
    if (!data) continue;
    const slOff = slotLastOffset(m.asset_index);
    const effOff = slOff - SLOT_LAST_IN_SLOT + SLOT_EFF_PRICE_IN_SLOT;
    if (slOff + 8 > data.length || effOff + 8 > data.length) continue;
    const eff = Number(data.readBigUInt64LE(effOff) as unknown as bigint);
    if (eff <= 0) continue; // slot not activated
    const slotLast = Number(data.readBigUInt64LE(slOff) as unknown as bigint);
    const behind = nowSlot - slotLast;
    if (behind < 5) continue; // already fresh, moving now (dt~0) would revert

    // Target = live mainnet price (atoms); fall back to the current mark.
    let target = eff;
    if (m.base_mint) {
      const usd = await tokenPrice(m.base_mint);
      if (usd && usd > 0) target = Math.round(usd * POS_SCALE);
    }
    // Clamp toward target within 90% of the allowed move for this push.
    const advance = Math.min(behind, MAX_ACCRUAL_DT);
    const factor = (0.9 * MAX_MOVE_BPS_PER_SLOT * advance) / 10_000;
    const up = Math.floor(eff * (1 + factor));
    const down = Math.max(1, Math.floor(eff * (1 - factor)));
    const push = Math.min(up, Math.max(down, target));
    const sig = await accrueOnce(conn, relayer, program, market, m.asset_index, BigInt(push));
    if (sig) pushed++;
  }
  return pushed;
}

// ---------- cached OHLCV candles (native chart history) ----------

const GECKO_API = "https://api.geckoterminal.com/api/v2";
const CANDLE_TF: Record<string, { tf: string; agg: number }> = {
  "1m": { tf: "minute", agg: 1 },
  "5m": { tf: "minute", agg: 5 },
  "15m": { tf: "minute", agg: 15 },
  "1h": { tf: "hour", agg: 1 },
};
const CANDLE_REFRESH_SEC = 90; // throttle upstream OHLCV pulls per (pool, tf)
const POOL_TTL_SEC = 86_400; // re-resolve mint -> pool daily

// Server-side GeckoTerminal GET with 429 backoff (no CORS constraint here).
async function geckoGet(p: string): Promise<any | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${GECKO_API}/${p}`, { headers: { accept: "application/json" } });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 500 * (i + 1)));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }
  return null;
}

async function resolvePoolForMint(env: Env, mint: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT pool, resolved_at FROM pool_map WHERE mint = ?")
    .bind(mint)
    .first<{ pool: string | null; resolved_at: number }>();
  if (row?.pool && now - row.resolved_at < POOL_TTL_SEC) return row.pool;
  const j = await geckoGet(`networks/solana/tokens/${mint}/pools?page=1`);
  let pool: string | null = row?.pool ?? null;
  if (j?.data) {
    const pools = (j.data as { attributes?: { address?: string; reserve_in_usd?: string } }[])
      .map((p) => p.attributes)
      .filter((a): a is { address: string; reserve_in_usd?: string } => !!a?.address)
      .sort((a, b) => Number(b.reserve_in_usd ?? 0) - Number(a.reserve_in_usd ?? 0));
    if (pools[0]?.address) pool = pools[0].address;
  }
  if (pool) {
    await env.DB.prepare(
      "INSERT INTO pool_map (mint,pool,resolved_at) VALUES (?,?,?) ON CONFLICT(mint) DO UPDATE SET pool=excluded.pool, resolved_at=excluded.resolved_at",
    )
      .bind(mint, pool, now)
      .run();
  }
  return pool;
}

// Pull fresh OHLCV from GeckoTerminal into D1, throttled to one fetch per
// CANDLE_REFRESH_SEC per (pool, tf). Best-effort: on 429/empty we keep whatever
// is already cached.
async function refreshCandles(env: Env, pool: string, tf: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const meta = await env.DB.prepare("SELECT last_fetch FROM candle_meta WHERE pool=? AND tf=?")
    .bind(pool, tf)
    .first<{ last_fetch: number }>();
  if (meta && now - meta.last_fetch < CANDLE_REFRESH_SEC) return;
  const g = CANDLE_TF[tf] ?? CANDLE_TF["15m"]!;
  const j = await geckoGet(
    `networks/solana/pools/${pool}/ohlcv/${g.tf}?aggregate=${g.agg}&limit=300`,
  );
  const list: number[][] = j?.data?.attributes?.ohlcv_list ?? [];
  if (!list.length) return; // keep cache; don't stamp meta so we retry soon
  const stmts = list
    .filter((r) => Number.isFinite(r[4]) && (r[4] as number) > 0)
    .map((r) =>
      env.DB.prepare(
        "INSERT INTO candles (pool,tf,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pool,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v",
      ).bind(pool, tf, r[0], r[1], r[2], r[3], r[4], r[5] ?? 0),
    );
  if (stmts.length) await env.DB.batch(stmts);
  await env.DB.prepare(
    "INSERT INTO candle_meta (pool,tf,last_fetch) VALUES (?,?,?) ON CONFLICT(pool,tf) DO UPDATE SET last_fetch=excluded.last_fetch",
  )
    .bind(pool, tf, now)
    .run();
}

// ---------- liquidation keeper ----------

// Attempt liquidation once a portfolio's equity drops below this fraction of its
// open notional. The engine is the source of truth, it rejects a still-healthy
// account with NonProgress, so this only needs to be a conservative trigger
// (slightly ABOVE the real maintenance margin) to catch every unhealthy account
// without missing bad debt. A too-eager attempt just wastes the relayer's tx fee.
const LIQ_TRIGGER_BPS = 800; // 8% of notional
const POS_SCALE_F = 1_000_000;

/// Scan every portfolio with open positions, mark each to the on-chain
/// effective_price, and liquidate any whose equity (capital + pnl) has fallen
/// below the maintenance trigger. Permissionless + engine-gatekept, signed by
/// the relayer. Without this, an account that goes underwater is never closed
/// and its bad debt accumulates against the vault.
async function liquidateUnhealthy(env: Env): Promise<number> {
  // All fills oldest-first, so we can replay each portfolio's VWAP entry and
  // mark its OPEN legs to market (the loss on an open position is unrealized,
  // it is NOT in the engine `pnl` field, so capital+pnl alone never trips the
  // trigger; we must add (mark − entry)·size).
  const { results } = await env.DB.prepare(
    "SELECT portfolio, market, asset_index, side, size_q, exec_price FROM trades WHERE portfolio != '' ORDER BY block_time ASC",
  ).all<{ portfolio: string; market: string; asset_index: number; side: number; size_q: string; exec_price: string }>();
  type Leg = { market: string; assetIndex: number; side: number; size: number; entry: number };
  const rowsByPf = new Map<string, NonNullable<typeof results>>();
  for (const r of results ?? []) {
    const arr = rowsByPf.get(r.portfolio) ?? [];
    arr.push(r);
    rowsByPf.set(r.portfolio, arr);
  }
  const legsByPf = new Map<string, Leg[]>();
  for (const [pf, rows] of rowsByPf) {
    const legs = computePositions(rows);
    if (legs.length) legsByPf.set(pf, legs);
  }
  if (!legsByPf.size) return 0;

  const conn = new Connection(env.RPC_URL, "confirmed");
  // Batch-read the distinct portfolio + market accounts we need.
  const portfolios = [...legsByPf.keys()];
  const markets = [...new Set([...legsByPf.values()].flat().map((l) => l.market))];
  const accInfo = async (keys: string[]) => {
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const res = await rpc<{ value: ({ data: [string, string] } | null)[] }>(
        env,
        "getMultipleAccounts",
        [batch, { encoding: "base64" }],
      );
      res?.value?.forEach((a, j) => {
        if (a?.data) out.set(batch[j]!, b64ToBytes(a.data[0]));
      });
    }
    return out;
  };
  const pfData = await accInfo(portfolios);
  const mktData = await accInfo(markets);

  // effective_price (USD) for a (market, slot).
  const effOf = (market: string, assetIndex: number): number => {
    const data = mktData.get(market);
    if (!data) return 0;
    const off = slotLastOffset(assetIndex) - SLOT_LAST_IN_SLOT + SLOT_EFF_PRICE_IN_SLOT;
    if (off + 8 > data.length) return 0;
    return Number(readUintLE(data, off, 8)) / POS_SCALE_F;
  };

  const relayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env.RELAYER_SECRET) as number[]),
  );
  const program = new PublicKey(env.PROGRAM_ID);
  let liquidated = 0;

  for (const [portfolio, legs] of legsByPf) {
    const data = pfData.get(portfolio);
    if (!data || data.length < OFFSET_PNL + 16) continue;
    const capital = Number(readUintLE(data, OFFSET_CAPITAL, 16)) / POS_SCALE_F;
    const pnl = Number(readIntLE(data, OFFSET_PNL, 16)) / POS_SCALE_F;
    // Mark-to-market equity = capital + realized pnl + unrealized leg PnL.
    // Long (side 0) gains when mark > entry; short (side 1) gains when mark <
    // entry. Liquidate using the SAME on-chain effective_price the engine
    // settles at (not the UI's live spot), so we agree with the engine's gate.
    let notional = 0;
    let unrealized = 0;
    for (const l of legs) {
      const eff = effOf(l.market, l.assetIndex);
      if (eff <= 0) continue;
      notional += l.size * eff;
      unrealized += (eff - l.entry) * l.size * (l.side === 0 ? 1 : -1);
    }
    if (notional <= 0) continue;
    const equity = capital + pnl + unrealized;
    const trigger = (notional * LIQ_TRIGGER_BPS) / 10_000;
    if (equity >= trigger) continue; // healthy enough, skip

    // Underwater: flatten each open leg. The engine still gatekeeps (rejects
    // NonProgress if it disagrees), so this is safe even on a stale read.
    for (const l of legs) {
      const closeQ = BigInt(Math.round(l.size * POS_SCALE_F));
      if (closeQ <= 0n) continue;
      try {
        const ix = new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: new PublicKey(l.market), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(portfolio), isSigner: false, isWritable: true },
            { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
          ],
          data: liquidateIxData(l.assetIndex, closeQ, 0n),
        });
        const tx = new Transaction().add(ix);
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = relayer.publicKey;
        tx.sign(relayer);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await conn.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        liquidated++;
      } catch {
        /* engine rejected (still healthy / stale) or RPC hiccup, retry next tick */
      }
    }
  }
  return liquidated;
}

// ---------- solvency / bad-debt monitor ----------

type HealthReport = {
  ts: number;
  accounts: number;
  totalEquityUsd: number;
  badDebtUsd: number; // Σ of negative equity, should be ~0 if the keeper works
  negativeAccounts: number;
  undercollateralized: { symbol: string; vault: number; cTot: number }[];
};

/// Two independent solvency signals:
///  1. Bad debt, Σ negative equity across the latest per-portfolio snapshots.
///     Non-zero means an account went underwater without being liquidated.
///  2. Per-market collateralization, the vault's real SPL balance must cover
///     the engine's recorded `c_tot` (total user capital). vault < c_tot means
///     the group can't honour withdrawals (a drain / accounting bug).
async function healthCheck(env: Env): Promise<HealthReport> {
  const { results: snaps } = await env.DB.prepare(
    `SELECT e.portfolio, e.capital, e.pnl FROM equity_snapshots e
     JOIN (SELECT portfolio, MAX(ts) mt FROM equity_snapshots GROUP BY portfolio) m
       ON e.portfolio = m.portfolio AND e.ts = m.mt`,
  ).all<{ portfolio: string; capital: string; pnl: string }>();
  let accounts = 0;
  let totalEquityUsd = 0;
  let badDebtUsd = 0;
  let negativeAccounts = 0;
  for (const r of snaps ?? []) {
    const eq = (Number(r.capital) + Number(r.pnl)) / POS_SCALE_F;
    accounts++;
    totalEquityUsd += eq;
    if (eq < 0) {
      badDebtUsd += -eq;
      negativeAccounts++;
    }
  }

  const undercollateralized: { symbol: string; vault: number; cTot: number }[] = [];
  const { results: mkts } = await env.DB.prepare(
    "SELECT pubkey, symbol, vault FROM custom_markets WHERE vault IS NOT NULL AND vault != ''",
  ).all<{ pubkey: string; symbol: string; vault: string }>();
  for (const m of mkts ?? []) {
    try {
      const acc = await rpc<{ value: { data: [string, string] } | null }>(env, "getAccountInfo", [
        m.pubkey,
        { encoding: "base64" },
      ]);
      const data = acc?.value?.data ? b64ToBytes(acc.value.data[0]) : null;
      if (!data || data.length < OFFSET_C_TOT + 16) continue;
      const cTot = Number(readUintLE(data, OFFSET_C_TOT, 16)) / POS_SCALE_F;
      const bal = await rpc<{ value: { uiAmount: number | null } }>(env, "getTokenAccountBalance", [
        m.vault,
      ]);
      const vault = Number(bal?.value?.uiAmount ?? 0);
      // Small tolerance for rounding; vault must cover user capital.
      if (vault + 0.01 < cTot) undercollateralized.push({ symbol: m.symbol, vault, cTot });
    } catch {
      /* skip a market we can't read this tick */
    }
  }

  return {
    ts: Math.floor(Date.now() / 1000),
    accounts,
    totalEquityUsd,
    badDebtUsd,
    negativeAccounts,
    undercollateralized,
  };
}

// Bad-debt threshold (USD) above which we page. Small accounts dust below this.
const BAD_DEBT_ALERT_USD = 1;

/// Fire a webhook alert when a solvency signal trips. No-op if ALERT_WEBHOOK is
/// unset. Discord-compatible ({content}).
async function maybeAlert(env: Env, h: HealthReport): Promise<void> {
  if (!env.ALERT_WEBHOOK) return;
  const problems: string[] = [];
  if (h.badDebtUsd > BAD_DEBT_ALERT_USD) {
    problems.push(`⚠️ Bad debt $${h.badDebtUsd.toFixed(2)} across ${h.negativeAccounts} account(s)`);
  }
  for (const u of h.undercollateralized) {
    problems.push(`🔴 ${u.symbol} undercollateralized: vault ${u.vault.toFixed(2)} < c_tot ${u.cTot.toFixed(2)}`);
  }
  if (!problems.length) return;
  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `**OpenPerps solvency alert**\n${problems.join("\n")}` }),
    });
  } catch {
    /* best-effort */
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await poll(env);
          await snapshotEquity(env);
          await relayPrices(env);
          // Push custom marks repeatedly across the minute (~12s cadence) instead
          // of once, so the mark tracks the realtime token price closely. With a
          // single push/min, a short hold sees no mark move and thus no PnL,
          // making winning trades look like they only paid a fee.
          for (let i = 0; i < 5; i++) {
            await relayCustomPrices(env);
            if (i < 4) await sleep(12_000);
          }
          await liquidateUnhealthy(env);
          // Delist rugged markets (LP < $3k), every ~5 min, not every tick, to
          // spare DexScreener and avoid acting on a momentary low reading.
          if (new Date(_event.scheduledTime).getUTCMinutes() % 5 === 0) {
            await pruneIlliquidMarkets(env);
          }
          const h = await healthCheck(env);
          await maybeAlert(env, h);
        } catch {
          /* best-effort cron */
        }
      })(),
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;

    // Realtime price WebSocket: route to the per-mint Durable Object so every
    // client for a token shares ONE upstream Helius connection.
    if (path === "/pricefeed") {
      const mint = url.searchParams.get("mint");
      if (!mint) return new Response("mint required", { status: 400, headers: CORS });
      const id = env.PRICE_FEED.idFromName(mint);
      return env.PRICE_FEED.get(id).fetch(req);
    }

    try {
      // Proxy GeckoTerminal server-side. The browser can't call it directly:
      // its free tier rate-limits hard and (worse) drops CORS headers on 429,
      // so the fetch is blocked outright. Here we fetch once and edge-cache the
      // result, so every user shares it and GeckoTerminal sees ~1 call per path
      // per TTL instead of one per user. `?path=` is the GeckoTerminal path
      // after /api/v2/.
      if (path === "/gecko") {
        const gp = url.searchParams.get("path");
        if (!gp) return json({ error: "path required" });
        const cache = (caches as unknown as { default: Cache }).default;
        const cacheKey = new Request(url.toString(), { method: "GET" });
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        // Retry server-side on 429 (no CORS constraint here): GeckoTerminal's
        // free tier is bursty, but once one request gets through we cache it for
        // every user, so total upstream calls stay ~1 per path per TTL.
        let body = JSON.stringify({ error: "gecko unavailable" });
        let status = 502;
        for (let i = 0; i < 4; i++) {
          try {
            const r = await fetch(`https://api.geckoterminal.com/api/v2/${gp}`, {
              headers: { accept: "application/json" },
            });
            status = r.status;
            if (r.status === 429) {
              await new Promise((res) => setTimeout(res, 600 * (i + 1)));
              continue;
            }
            body = await r.text();
            break;
          } catch {
            status = 502;
            break;
          }
        }
        // Pool lookups are stable (cache long); prices/OHLCV move (cache short).
        const ttl = gp.includes("/pools?") ? 3600 : 45;
        const resp = new Response(body, {
          status,
          headers: { "content-type": "application/json", ...CORS, "cache-control": `public, max-age=${ttl}` },
        });
        if (status === 200) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      }

      // Cached OHLCV candles for the native chart. Serves DEX-pool history from
      // D1 so GeckoTerminal is hit at most ~once per (pool, tf) per refresh
      // window regardless of how many users watch, flat cost, and history
      // survives GeckoTerminal rate-limiting once seeded. Returns
      // { ohlcv_list: [[t,o,h,l,c,v], ...] } ascending (same shape the frontend
      // already parses). `tf` ∈ 1m|5m|15m|1h.
      if (path === "/candles") {
        const mint = url.searchParams.get("mint");
        const tf = url.searchParams.get("tf") ?? "15m";
        if (!mint || !CANDLE_TF[tf]) return json({ ohlcv_list: [] });
        const pool = await resolvePoolForMint(env, mint);
        if (!pool) return json({ ohlcv_list: [] });
        const have = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM candles WHERE pool=? AND tf=?",
        )
          .bind(pool, tf)
          .first<{ n: number }>();
        // Cold (nothing cached): block to populate so the first viewer gets
        // candles. Warm: serve cache instantly and refresh in the background.
        if (!have || have.n === 0) {
          try {
            await refreshCandles(env, pool, tf);
          } catch {
            /* serve whatever we have (possibly empty) */
          }
        } else {
          ctx.waitUntil(refreshCandles(env, pool, tf).catch(() => {}));
        }
        const { results } = await env.DB.prepare(
          "SELECT t,o,h,l,c,v FROM candles WHERE pool=? AND tf=? ORDER BY t ASC LIMIT 500",
        )
          .bind(pool, tf)
          .all<{ t: number; o: number; h: number; l: number; c: number; v: number }>();
        const ohlcv_list = (results ?? []).map((r) => [r.t, r.o, r.h, r.l, r.c, r.v]);
        return json({ ohlcv_list });
      }

      // Manual poll + snapshot trigger (handy for testing / first fill).
      if (path === "/poll") {
        const n = await poll(env);
        const snaps = await snapshotEquity(env);
        return json({ inserted: n, snapshots: snaps });
      }

      // Manual liquidation-keeper trigger (the cron runs it every minute too).
      if (path === "/liquidate") {
        const n = await liquidateUnhealthy(env);
        return json({ liquidated: n });
      }

      // Solvency / bad-debt dashboard (the cron also alerts on this).
      if (path === "/health") {
        return json(await healthCheck(env));
      }

      // Manual custom-market price relay (the cron runs it every minute too).
      if (path === "/relaycustom") {
        const pushed = await relayCustomPrices(env);
        return json({ pushed });
      }

      // Manual auto-delist sweep, remove custom markets whose LP fell below
      // $3k (the cron runs this every ~5 min too).
      if (path === "/prune") {
        return json(await pruneIlliquidMarkets(env));
      }

      // Immediate single-tx ingest. The frontend fires this (fire-and-forget)
      // right after a trade confirms, so the fill is parsed + stored within
      // seconds, on EVERY device, keyed by the wallet, instead of waiting for
      // the 1-min cron. This makes the VWAP entry (/positions) and history
      // (/trades) durable + cross-browser fast; the client's localStorage log is
      // only a same-device instant cache, never the source of truth.
      if (path === "/ingest") {
        const sig = url.searchParams.get("sig");
        if (!sig) return json({ error: "sig required" });
        try {
          const trade = await parseTrade(env, { signature: sig, err: null });
          if (trade) {
            await upsertTrade(env, trade);
            return json({ ok: true, ingested: true });
          }
          return json({ ok: true, ingested: false });
        } catch (e) {
          return json({ ok: false, error: String(e) });
        }
      }

      // Register a market's price source so the relayer can fetch it. Called
      // by the frontend on launch: { assetIndex, symbol, pythFeedId, baseMint }.
      if (path === "/register" && req.method === "POST") {
        const b = (await req.json()) as {
          assetIndex?: number;
          symbol?: string;
          pythFeedId?: string;
          baseMint?: string;
        };
        if (b.assetIndex === undefined || !b.symbol) {
          return json({ error: "assetIndex + symbol required" });
        }
        await env.DB.prepare(
          `INSERT INTO markets (asset_index, symbol, pyth_feed_id, base_mint, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(asset_index) DO UPDATE SET
             symbol=excluded.symbol, pyth_feed_id=excluded.pyth_feed_id,
             base_mint=excluded.base_mint, updated_at=excluded.updated_at`,
        )
          .bind(
            b.assetIndex,
            b.symbol,
            b.pythFeedId ?? null,
            b.baseMint ?? null,
            Math.floor(Date.now() / 1000),
          )
          .run();
        return json({ ok: true });
      }

      // Shared registry of permissionless custom-market launches. POST upserts
      // a launch (called by the browser right after ActivateMarket); GET lists
      // them so every wallet/device discovers the same markets, not just the
      // launcher's localStorage. Keyed by the market account pubkey.
      if (path === "/markets" && req.method === "POST") {
        const b = (await req.json()) as Record<string, any>;
        if (!b.pubkey || !b.symbol || !b.base) {
          return json({ error: "pubkey + symbol + base required" });
        }
        await env.DB.prepare(
          `INSERT INTO custom_markets
             (pubkey, symbol, base, quote_mint, vault, asset_slot_capacity,
              asset_index, base_mint, oracle_kind, oracle_pool, max_leverage,
              fee_bps, seed_price_usd, house, house_bump, own_group, seed_lp,
              created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(pubkey) DO UPDATE SET
             symbol=excluded.symbol, base=excluded.base,
             quote_mint=excluded.quote_mint, vault=excluded.vault,
             asset_slot_capacity=excluded.asset_slot_capacity,
             asset_index=excluded.asset_index, base_mint=excluded.base_mint,
             oracle_kind=excluded.oracle_kind, oracle_pool=excluded.oracle_pool,
             max_leverage=excluded.max_leverage, fee_bps=excluded.fee_bps,
             seed_price_usd=excluded.seed_price_usd, house=excluded.house,
             house_bump=excluded.house_bump, own_group=excluded.own_group,
             seed_lp=excluded.seed_lp`,
        )
          .bind(
            b.pubkey,
            b.symbol,
            b.base,
            b.quoteMint ?? null,
            b.vault ?? null,
            b.assetSlotCapacity ?? 0,
            b.assetIndex ?? 0,
            b.baseMint ?? null,
            b.oracleKind ?? null,
            b.oraclePool ?? null,
            b.maxLeverage ?? null,
            b.feeBps ?? null,
            b.seedPriceUsd ?? null,
            b.house ?? null,
            b.houseBump ?? null,
            b.ownGroup ? 1 : 0,
            b.seedLp ?? null,
            Math.floor(Date.now() / 1000),
          )
          .run();
        return json({ ok: true });
      }

      if (path === "/markets") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM custom_markets ORDER BY created_at DESC",
        ).all<any>();
        return json((results ?? []).map(rowToCustomMarket));
      }

      // Manual relayer trigger (push live prices on-chain now). `?steps=N`
      // bursts up to N confirmed accruals per asset to burn down a slot_last
      // backlog (clears the stale-loss lock); default keeps the normal cadence.
      if (path === "/relay") {
        const stepsRaw = Number(url.searchParams.get("steps") ?? 3);
        const steps = Math.max(1, Math.min(Number.isFinite(stepsRaw) ? stepsRaw : 3, 40));
        const pushed = await relayPrices(env, steps);
        return json({ pushed, steps });
      }

      // Activate a fresh asset slot at a seed price (bootstrap official
      // markets). POST { assetIndex, priceUsd }. Signed by the relayer key.
      if (path === "/activate" && req.method === "POST") {
        const b = (await req.json()) as {
          assetIndex?: number;
          priceUsd?: number;
        };
        if (b.assetIndex === undefined || !b.priceUsd) {
          return json({ error: "assetIndex + priceUsd required" });
        }
        const atoms = BigInt(Math.round(b.priceUsd * POS_SCALE));
        const sig = await activateSlot(env, b.assetIndex, atoms);
        return json({ ok: true, signature: sig });
      }

      // One-time backfill of the portfolio column on older rows.
      if (path === "/backfill") {
        const n = await backfill(env, 200);
        const snaps = await snapshotEquity(env);
        return json({ backfilled: n, snapshots: snaps });
      }

      // Every (portfolio, market) the wallet has traded, so positions/accounts
      // are discoverable on ANY device, not just the browser that created the
      // portfolio (portfolios are random keypairs stored only in localStorage;
      // without this, a second browser can't see them). Parsed from on-chain
      // trades, keyed by the wallet: [{ portfolio, market }].
      if (path === "/portfolios") {
        const owner = url.searchParams.get("owner");
        if (!owner) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT DISTINCT portfolio, market FROM trades WHERE trader = ?",
        )
          .bind(owner)
          .all<{ portfolio: string; market: string }>();
        return json(results ?? []);
      }

      // Open positions with a VWAP entry derived from the owner's fills, so
      // the UI can show entry / unrealized / liq honestly (observed from
      // trades, not engine internals): [{ assetIndex, side, size, entry }].
      if (path === "/positions") {
        const owner = url.searchParams.get("owner");
        if (!owner) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT market, asset_index, side, size_q, exec_price FROM trades WHERE trader = ? ORDER BY block_time ASC",
        )
          .bind(owner)
          .all<any>();
        return json(computePositions(results ?? []));
      }

      // Equity curve for a portfolio: [{ ts, equity }] in USD.
      if (path === "/equity") {
        const portfolio = url.searchParams.get("portfolio");
        if (!portfolio) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT ts, capital, pnl FROM equity_snapshots WHERE portfolio = ? ORDER BY ts DESC LIMIT 500",
        )
          .bind(portfolio)
          .all<{ ts: number; capital: string; pnl: string }>();
        const points = (results ?? [])
          .reverse()
          .map((r) => ({
            ts: r.ts * 1000,
            equity: (Number(r.capital) + Number(r.pnl)) / POS_SCALE,
          }));
        return json(points);
      }

      // Recent global trades, or per-owner with ?owner=
      if (path === "/trades") {
        const owner = url.searchParams.get("owner");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);
        const stmt = owner
          ? env.DB.prepare(
              "SELECT * FROM trades WHERE trader = ? ORDER BY block_time DESC LIMIT ?",
            ).bind(owner, limit)
          : env.DB.prepare(
              "SELECT * FROM trades ORDER BY block_time DESC LIMIT ?",
            ).bind(limit);
        const { results } = await stmt.all<any>();
        return json((results ?? []).map(rowToTrade));
      }

      // 24h stats per asset slot (volume, trade count) and optionally all.
      if (path === "/stats") {
        const since = Math.floor(Date.now() / 1000) - 86400;
        const { results } = await env.DB.prepare(
          `SELECT asset_index,
                  COUNT(*) AS trades,
                  SUM(CAST(size_q AS REAL) / ? * CAST(exec_price AS REAL) / ?) AS volume
           FROM trades WHERE block_time >= ? GROUP BY asset_index`,
        )
          .bind(POS_SCALE, POS_SCALE, since)
          .all<any>();
        const bySlot: Record<number, { trades: number; volume: number }> = {};
        for (const r of results ?? [])
          bySlot[r.asset_index] = { trades: r.trades, volume: r.volume ?? 0 };
        return json(bySlot);
      }

      // 24h fees paid by an owner (sum notional * fee_bps / 1e4).
      if (path === "/fees") {
        const owner = url.searchParams.get("owner");
        if (!owner) return json({ fees24h: 0 });
        const since = Math.floor(Date.now() / 1000) - 86400;
        const row = await env.DB.prepare(
          `SELECT SUM(CAST(size_q AS REAL)/? * CAST(exec_price AS REAL)/? * fee_bps / 10000) AS fees
           FROM trades WHERE trader = ? AND block_time >= ?`,
        )
          .bind(POS_SCALE, POS_SCALE, owner, since)
          .first<{ fees: number | null }>();
        return json({ fees24h: row?.fees ?? 0 });
      }

      return json({ ok: true, service: "openperps-indexer" });
    } catch (e) {
      return json({ error: String(e) });
    }
  },
};
