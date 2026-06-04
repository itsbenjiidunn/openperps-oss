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
