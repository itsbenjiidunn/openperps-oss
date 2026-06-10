// Auth for the indexer Worker. Kept in its own module so the gate is easy to
// reason about and unit test without the full Worker runtime.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

// Keeper / admin endpoints: they sign with the relayer key or mutate shared
// state, so they require the ADMIN_SECRET bearer token. The cron `scheduled`
// handler calls the same routines directly and is unaffected. Read endpoints and
// the user-facing registry writes are intentionally not listed here.
export const ADMIN_PATHS = new Set<string>([
  "/relay",
  "/relaycustom",
  "/activate",
  "/liquidate",
  "/prune",
  "/poll",
  "/backfill",
  // /register writes the asset_index -> feed/mint mapping that `relayPrices`
  // reads to sign AccrueAsset pushes, so an open /register would let anyone
  // re-point an asset's price source. It mutates relayer-trusted state -> admin.
  "/register",
]);

// Length-checked constant-time string compare (avoids an early-exit timing leak).
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Bearer-token gate. Fail-closed: with ADMIN_SECRET unset the endpoint is
// disabled (503) rather than left open. Returns a Response to short-circuit, or
// null when the caller is authorized.
export function requireAdmin(
  req: Request,
  env: { ADMIN_SECRET?: string },
): Response | null {
  const secret = env.ADMIN_SECRET;
  if (!secret) {
    return new Response("admin endpoints disabled (ADMIN_SECRET unset)", {
      status: 503,
      headers: CORS,
    });
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, secret)) {
    return new Response("unauthorized", { status: 401, headers: CORS });
  }
  return null;
}

// Open-write guard: a payload-size cap plus a best-effort per-IP rate limit for
// the unauthenticated registry writes (POST /markets). The limiter is in-memory
// per Worker isolate, so it is best-effort (Cloudflare may spread requests across
// isolates), but together with the body cap and the on-chain market check it
// blunts cheap DB-write / RPC-cost abuse. Returns a Response to short-circuit, or
// null when the request is within limits.
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 30; // requests per IP
const RATE_WINDOW_MS = 60_000; // per minute

const ipHits = new Map<string, number[]>();

export function guardOpenWrite(req: Request): Response | null {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload too large" }), {
      status: 413,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    ipHits.set(ip, recent);
    return new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { ...CORS, "content-type": "application/json", "retry-after": "60" },
    });
  }
  recent.push(now);
  ipHits.set(ip, recent);
  // Bound memory: occasionally drop fully-expired buckets.
  if (ipHits.size > 5_000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) ipHits.delete(k);
    }
  }
  return null;
}
