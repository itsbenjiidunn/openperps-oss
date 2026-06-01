# Oracle And Price Safety

OpenPerps does not need to be the market data provider in v1.

Integrators provide their own price source and chart data.

Client-rendered prices, chart prices, DOM-scraped prices, and third-party
frontend prices can be used for display and prefill only. Settlement, PnL,
funding, and liquidation must use the keeper/oracle path.

The keeper consumes a `PriceProvider` interface and pushes authenticated prices
on-chain.

The current manual authority oracle path is acceptable for devnet/demo flows but
is not production-approved for serious mainnet use. The authority-pushed oracle
trust model is the first mainnet blocker to remove.
