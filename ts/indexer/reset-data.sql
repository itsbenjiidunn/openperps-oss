-- Fresh-D1 reset: clear accumulated CUSTOM-market data so only newly launched
-- markets show, without touching the schema, the majors registry (`markets`),
-- or the ingest `cursor` (keeping the cursor stops a re-scan from re-importing
-- the deleted trades). The on-chain program 4zZDZa is unchanged.
DELETE FROM custom_markets;
DELETE FROM trades;
DELETE FROM equity_snapshots;
DELETE FROM candles;
DELETE FROM candle_meta;
DELETE FROM pool_map;
