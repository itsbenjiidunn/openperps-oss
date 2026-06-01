-- Relayer v3: slot → asset mapping so the price relayer knows which Pyth feed
-- / mint to fetch for each market (the browser registers it on launch).
CREATE TABLE IF NOT EXISTS markets (
  asset_index  INTEGER PRIMARY KEY,
  symbol       TEXT NOT NULL,
  pyth_feed_id TEXT,
  base_mint    TEXT,
  updated_at   INTEGER
);
