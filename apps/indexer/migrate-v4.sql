-- Indexer v4: a shared registry of permissionless custom-market launches.
-- Each launch is its OWN isolated group account, so we key by the market
-- pubkey (not asset_index, which is always 0 for an own-group market). The
-- browser POSTs here on launch; every other wallet/device reads it back, so
-- launched markets are discoverable globally instead of living only in the
-- launcher's localStorage.
CREATE TABLE IF NOT EXISTS custom_markets (
  pubkey              TEXT PRIMARY KEY,
  symbol              TEXT NOT NULL,
  base                TEXT NOT NULL,
  quote_mint          TEXT,
  vault               TEXT,
  asset_slot_capacity INTEGER,
  asset_index         INTEGER,
  base_mint           TEXT,
  oracle_kind         TEXT,
  oracle_pool         TEXT,
  max_leverage        REAL,
  fee_bps             INTEGER,
  seed_price_usd      REAL,
  house               TEXT,
  house_bump          INTEGER,
  own_group           INTEGER,
  seed_lp             REAL,
  created_at          INTEGER
);
