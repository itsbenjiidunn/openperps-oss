# Deployment Checklist

OpenPerps OSS is infrastructure; a deployment is configured and operated by the
integrating team. Decide each of these before putting a deployment in front of
real users.

## Oracle

- [ ] Choose the price source per market (see [`oracle-and-price-safety.md`](oracle-and-price-safety.md)).
- [ ] Majors: wire a production feed (Pyth / Switchboard). The on-chain Pyth CPI
      is not implemented in v1; do not rely on `oracle_kind = PYTH` for settlement.
- [ ] Custom SPL tokens: use the DEX-EWMA path against a pool with real depth, and
      set `max_price_move_bps_per_slot`, `max_accrual_dt_slots`, and the deposit cap
      for that pool's liquidity.
- [ ] Decide who holds the oracle authority key and your key-rotation process.

## Keeper

- [ ] Run your own keeper (oracle crank, funding, liquidation scan); see [`keeper.md`](keeper.md).
- [ ] Size the crank interval against `max_accrual_dt_slots` so markets never go
      stale; a stale slot locks risk-increasing trades.
- [ ] Monitor crank liveness and alert on stale markets.

## Liquidity and risk

- [ ] Fund the House/LP vault enough to counterparty the expected open interest.
- [ ] Set margin, fee, and liquidation parameters in the market config.
- [ ] Set the per-portfolio collateral cap for DEX-priced markets.

## Custody and review

- [ ] Confirm the collateral SPL mint and vault PDAs.
- [ ] Review the program wrapper, the SDK build path, and the keeper for your config.
- [ ] Test the full lifecycle on devnet: create market, fund House, trade,
      close/settle, withdraw.
