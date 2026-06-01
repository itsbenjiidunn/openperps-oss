-- OpenPerps indexer schema (Cloudflare D1 / SQLite).
-- v1: derive a real trade feed (and volume / OI / fees) from PlaceOrder txs.

CREATE TABLE IF NOT EXISTS cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sig TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  signature   TEXT PRIMARY KEY,
  block_time  INTEGER NOT NULL,
  market      TEXT NOT NULL,
  asset_index INTEGER NOT NULL,
  side        INTEGER NOT NULL,   -- 0 long, 1 short
  size_q      TEXT NOT NULL,      -- u128 as decimal string
  exec_price  TEXT NOT NULL,      -- u64 atoms as decimal string
  fee_bps     INTEGER NOT NULL,
  trader      TEXT NOT NULL,
  portfolio   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader);
CREATE INDEX IF NOT EXISTS idx_trades_slot ON trades(asset_index, block_time DESC);

-- v2: per-portfolio equity snapshots (capital + realized pnl over time).
CREATE TABLE IF NOT EXISTS equity_snapshots (
  portfolio TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  capital   TEXT NOT NULL,
  pnl       TEXT NOT NULL,
  PRIMARY KEY (portfolio, ts)
);

CREATE INDEX IF NOT EXISTS idx_equity ON equity_snapshots(portfolio, ts);
