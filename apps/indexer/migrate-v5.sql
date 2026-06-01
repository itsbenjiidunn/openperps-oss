-- Indexer v5: cached OHLCV candles for native charts.
--
-- The native chart needs DEX-pool history for each token. GeckoTerminal's free
-- tier 429s the Worker's (shared Cloudflare egress) IP almost immediately, so
-- fetching per page-load — even through the /gecko proxy — fails ("gecko
-- unavailable"). Instead we fetch a pool's OHLCV at most once per refresh window
-- and cache it here, then serve EVERY client from D1. GeckoTerminal sees ~1 call
-- per (pool, tf) per window regardless of how many users are watching → flat
-- cost, and once seeded the history survives even when GeckoTerminal rate-limits.

CREATE TABLE IF NOT EXISTS candles (
  pool TEXT NOT NULL,           -- GeckoTerminal pool address
  tf   TEXT NOT NULL,           -- '1m' | '5m' | '15m' | '1h'
  t    INTEGER NOT NULL,        -- candle bucket start (unix seconds)
  o    REAL,
  h    REAL,
  l    REAL,
  c    REAL,
  v    REAL,
  PRIMARY KEY (pool, tf, t)
);
CREATE INDEX IF NOT EXISTS candles_pool_tf_t ON candles (pool, tf, t);

-- Last time we hit GeckoTerminal for a (pool, tf), so we throttle upstream
-- fetches to one per refresh window and serve cache in between.
CREATE TABLE IF NOT EXISTS candle_meta (
  pool       TEXT NOT NULL,
  tf         TEXT NOT NULL,
  last_fetch INTEGER,
  PRIMARY KEY (pool, tf)
);

-- mint -> deepest GeckoTerminal pool, resolved once and cached (pool lookups are
-- stable; don't re-resolve every load).
CREATE TABLE IF NOT EXISTS pool_map (
  mint        TEXT PRIMARY KEY,
  pool        TEXT,
  resolved_at INTEGER
);
