/// PriceFeed Durable Object, ONE upstream Helius WebSocket per token, fanned
/// out to every connected client. Collapses N user connections to 1 Helius
/// connection per mint, so realtime price scales flat with users (credits are
/// per-token, not per-user). Resolves the token's Raydium v4 / pumpswap pool,
/// subscribes to its two vaults, recomputes price on each swap, and broadcasts.

import { PublicKey } from "@solana/web3.js";

// Mainnet RPC for reading pool reserves + SOL price. The Helius key now lives
// in the `MAINNET_RPC` Worker secret, applied in the DO constructor below; this
// keyless public host is only the fallback if the secret is unset.
let MAINNET_RPC = "https://api.mainnet-beta.solana.com";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";

const RAY_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY = { baseDecimal: 32, quoteDecimal: 40, baseVault: 336, quoteVault: 368, baseMint: 400, quoteMint: 432 };
const PUMP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP = { baseMint: 43, quoteMint: 75, baseVault: 139, quoteVault: 171 };
const TOKEN_AMOUNT_OFFSET = 64;
const MINT_DECIMALS_OFFSET = 44;

const SOL_PYTH_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_LATEST = "https://hermes.pyth.network/v2/updates/price/latest";

type Source = { ourVault: string; otherVault: string; ourDec: number; otherDec: number; otherMint: string };

function u64LE(b: Buffer, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}
function pubkeyAt(b: Buffer, off: number): string {
  return new PublicKey(b.subarray(off, off + 32)).toBase58();
}
function tokenAmount(b64: string | undefined): bigint {
  if (!b64) return 0n;
  const b = Buffer.from(b64, "base64");
  return b.length >= TOKEN_AMOUNT_OFFSET + 8 ? u64LE(b, TOKEN_AMOUNT_OFFSET) : 0n;
}
function mintDecimals(b64: string | undefined): number | null {
  if (!b64) return null;
  const b = Buffer.from(b64, "base64");
  return b.length > MINT_DECIMALS_OFFSET ? b[MINT_DECIMALS_OFFSET]! : null;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { result?: T }).result ?? null;
  } catch {
    return null;
  }
}

async function solUsd(): Promise<number | null> {
  try {
    const res = await fetch(`${HERMES_LATEST}?ids[]=${SOL_PYTH_FEED}&parsed=true`);
    if (!res.ok) return null;
    const j = (await res.json()) as { parsed?: { price?: { price?: string; expo?: number } }[] };
    const p = j.parsed?.[0]?.price;
    if (!p || p.price === undefined || p.expo === undefined) return null;
    const v = Number(p.price) * 10 ** p.expo;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/// Candidate pool addresses for a mint, deepest first. GeckoTerminal first;
/// DexScreener as a fallback (it's CORS-open and far less rate-limited than
/// GeckoTerminal's free tier, which 429s the DO's direct server-side fetch and
/// would otherwise leave the feed, price AND liquidity, silent).
async function poolCandidates(mint: string): Promise<{ address: string; reserve_in_usd?: string }[]> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      if (!res.ok) break;
      const j = (await res.json()) as { data?: { attributes?: { address?: string; reserve_in_usd?: string } }[] };
      const pools = (j.data ?? [])
        .map((p) => p.attributes)
        .filter((a): a is { address: string; reserve_in_usd?: string } => !!a?.address)
        .sort((a, b) => Number(b.reserve_in_usd ?? 0) - Number(a.reserve_in_usd ?? 0));
      if (pools.length) return pools;
      break;
    } catch {
      break;
    }
  }
  // Fallback: DexScreener pair addresses (deepest liquidity first).
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return [];
    const j = (await res.json()) as {
      pairs?: { chainId?: string; pairAddress?: string; liquidity?: { usd?: number } }[];
    };
    return (j.pairs ?? [])
      .filter((p) => p.chainId === "solana" && p.pairAddress)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
      .map((p) => ({ address: p.pairAddress!, reserve_in_usd: String(p.liquidity?.usd ?? 0) }));
  } catch {
    return [];
  }
}

async function resolveSource(mint: string): Promise<Source | null> {
  const pools = await poolCandidates(mint);
  if (!pools.length) return null;

  for (const p of pools.slice(0, 5)) {
    const acc = await rpc<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [
      p.address,
      { encoding: "base64" },
    ]);
    const v = acc?.value;
    if (!v) continue;
    const data = Buffer.from(v.data[0], "base64");
    let baseMint: string, quoteMint: string, baseVault: string, quoteVault: string, baseDec: number, quoteDec: number;
    if (v.owner === RAY_V4_PROGRAM && data.length >= RAY.quoteMint + 32) {
      baseMint = pubkeyAt(data, RAY.baseMint);
      quoteMint = pubkeyAt(data, RAY.quoteMint);
      baseVault = pubkeyAt(data, RAY.baseVault);
      quoteVault = pubkeyAt(data, RAY.quoteVault);
      baseDec = Number(u64LE(data, RAY.baseDecimal));
      quoteDec = Number(u64LE(data, RAY.quoteDecimal));
    } else if (v.owner === PUMP_PROGRAM && data.length >= PUMP.quoteVault + 32) {
      baseMint = pubkeyAt(data, PUMP.baseMint);
      quoteMint = pubkeyAt(data, PUMP.quoteMint);
      baseVault = pubkeyAt(data, PUMP.baseVault);
      quoteVault = pubkeyAt(data, PUMP.quoteVault);
      const md = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
        [baseMint, quoteMint],
        { encoding: "base64" },
      ]);
      const bd = mintDecimals(md?.value?.[0]?.data?.[0]);
      const qd = mintDecimals(md?.value?.[1]?.data?.[0]);
      if (bd === null || qd === null) continue;
      baseDec = bd;
      quoteDec = qd;
    } else {
      continue;
    }
    if (baseMint === mint)
      return { ourVault: baseVault, otherVault: quoteVault, ourDec: baseDec, otherDec: quoteDec, otherMint: quoteMint };
    if (quoteMint === mint)
      return { ourVault: quoteVault, otherVault: baseVault, ourDec: quoteDec, otherDec: baseDec, otherMint: baseMint };
  }
  return null;
}

export class PriceFeed {
  private clients = new Set<WebSocket>();
  private mint = "";
  private started = false;
  private src: Source | null = null;
  private helius: WebSocket | null = null;
  private solTimer: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private st = { our: 0n, other: 0n, ourDec: 0, otherDec: 0, kind: "none" as "usd" | "sol" | "none", solUsd: 0, last: 0, liq: 0 };
  private lastEmit = 0;

  // (state, env) are provided by the runtime; we keep everything in memory.
  constructor(_state: DurableObjectState, env: { MAINNET_RPC?: string }) {
    // Apply the mainnet RPC secret (Helius key) once per isolate; the module
    // helpers above read this same `MAINNET_RPC`. Falls back to the public host.
    if (env?.MAINNET_RPC) MAINNET_RPC = env.MAINNET_RPC;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const mint = url.searchParams.get("mint") ?? "";
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;
    server.accept();
    this.clients.add(server);
    if (this.st.last > 0)
      server.send(JSON.stringify({ price: this.st.last, liquidity: this.st.liq }));
    const drop = () => {
      this.clients.delete(server);
      this.maybeStop();
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    if (!this.started && mint) {
      this.mint = mint;
      this.started = true;
      void this.start();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async start(): Promise<void> {
    const src = await resolveSource(this.mint);
    // Couldn't resolve a decodable USD/SOL-quoted pool (e.g. aggregators
    // rate-limited the lookup). Allow a later connection to retry instead of
    // wedging this mint silent forever.
    if (!src) {
      this.started = false;
      return;
    }
    this.src = src;
    this.st.ourDec = src.ourDec;
    this.st.otherDec = src.otherDec;
    this.st.kind =
      src.otherMint === USDC || src.otherMint === USDT ? "usd" : src.otherMint === WSOL ? "sol" : "none";
    if (this.st.kind === "none") {
      this.started = false;
      return;
    }

    if (this.st.kind === "sol") {
      const pull = async () => {
        const v = await solUsd();
        if (v) {
          this.st.solUsd = v;
          this.recompute();
        }
      };
      await pull();
      this.solTimer = setInterval(pull, 15_000);
    }

    const accs = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
      [src.ourVault, src.otherVault],
      { encoding: "base64" },
    ]);
    if (accs?.value) {
      this.st.our = tokenAmount(accs.value[0]?.data?.[0]);
      this.st.other = tokenAmount(accs.value[1]?.data?.[0]);
      this.recompute();
    }
    this.connectHelius();
  }

  private connectHelius(): void {
    if (!this.src || this.clients.size === 0) return;
    const src = this.src;
    fetch(MAINNET_RPC, { headers: { Upgrade: "websocket" } })
      .then((resp) => {
        const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
        if (!ws) return;
        ws.accept();
        this.helius = ws;
        const subOf = new Map<number, "our" | "other">();
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [src.ourVault, { encoding: "base64", commitment: "processed" }] }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "accountSubscribe", params: [src.otherVault, { encoding: "base64", commitment: "processed" }] }));
        ws.addEventListener("message", (e: MessageEvent) => {
          try {
            const j = JSON.parse(e.data as string) as {
              id?: number;
              result?: number;
              method?: string;
              params?: { subscription?: number; result?: { value?: { data?: [string, string] } } };
            };
            if (j.id === 1 && typeof j.result === "number") subOf.set(j.result, "our");
            else if (j.id === 2 && typeof j.result === "number") subOf.set(j.result, "other");
            else if (j.method === "accountNotification") {
              const sub = j.params?.subscription;
              const d = j.params?.result?.value?.data?.[0];
              if (sub === undefined || d === undefined) return;
              const amt = tokenAmount(d);
              if (subOf.get(sub) === "our") this.st.our = amt;
              else if (subOf.get(sub) === "other") this.st.other = amt;
              this.recompute();
            }
          } catch {
            /* ignore */
          }
        });
        ws.addEventListener("close", () => {
          this.helius = null;
          if (this.clients.size > 0) this.reconnect = setTimeout(() => this.connectHelius(), 3_000);
        });
        ws.addEventListener("error", () => {
          try {
            ws.close();
          } catch {
            /* */
          }
        });
      })
      .catch(() => {
        if (this.clients.size > 0) this.reconnect = setTimeout(() => this.connectHelius(), 3_000);
      });
  }

  private recompute(): void {
    if (this.st.our === 0n) return;
    const our = Number(this.st.our) / 10 ** this.st.ourDec;
    const other = Number(this.st.other) / 10 ** this.st.otherDec;
    if (our <= 0) return;
    const inOther = other / our;
    const usd = this.st.kind === "usd" ? inOther : this.st.kind === "sol" ? inOther * this.st.solUsd : 0;
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    this.st.last = usd;
    // Pool liquidity (USD) = value of BOTH sides ≈ 2× the quote side. Available
    // straight from the vault balances we already track, so a brand-new market
    // shows liquidity instantly, before DexScreener/GeckoTerminal index the pool.
    const otherUsd = this.st.kind === "usd" ? other : other * this.st.solUsd;
    this.st.liq = otherUsd > 0 && Number.isFinite(otherUsd) ? otherUsd * 2 : 0;
    // Throttle fan-out to ~5/sec so a busy pool doesn't spam every client.
    const now = Date.now();
    if (now - this.lastEmit < 200) return;
    this.lastEmit = now;
    this.broadcast();
  }

  private broadcast(): void {
    const msg = JSON.stringify({ price: this.st.last, liquidity: this.st.liq });
    for (const c of this.clients) {
      try {
        c.send(msg);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  private maybeStop(): void {
    if (this.clients.size > 0) return;
    try {
      this.helius?.close();
    } catch {
      /* */
    }
    this.helius = null;
    if (this.solTimer) clearInterval(this.solTimer);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.started = false;
    this.st.last = 0;
  }
}
