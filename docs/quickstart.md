# Quickstart

OpenPerps examples are devnet-default.

The fastest integration path is:

1. load or create an `OpenPerpsMarketConfig`
2. create a `MarketRegistryProvider`
3. build a trade intent
4. use SDK build-only helpers for wallet apps or send-ready actions for Node scripts
5. run a keeper against the same market config

Mainnet-capable means SDK/config/program flows can target `mainnet-beta`. The
current authority-pushed oracle path is not production-approved and is the main
blocker for serious mainnet use.
