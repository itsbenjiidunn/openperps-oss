-- Indexer v2: per-portfolio equity snapshots + capture the portfolio account
-- on each trade (accounts[1]) so we know which portfolios to snapshot.

ALTER TABLE trades ADD COLUMN portfolio TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS equity_snapshots (
  portfolio TEXT NOT NULL,
  ts        INTEGER NOT NULL,   -- unix seconds (per-minute bucket)
  capital   TEXT NOT NULL,      -- u128 atoms as string
  pnl       TEXT NOT NULL,      -- i128 atoms as string
  PRIMARY KEY (portfolio, ts)
);

CREATE INDEX IF NOT EXISTS idx_equity ON equity_snapshots(portfolio, ts);
