# Quickstart

OpenPerps examples use sample Solana cluster configuration and can be adapted for
each integrator's deployment.

The fastest integration path is:

1. load or create an `OpenPerpsMarketConfig`
2. create a `MarketRegistryProvider`
3. build a trade intent
4. use SDK build-only helpers for wallet apps or send-ready actions for Node scripts
5. run a keeper against the same market config

The SDK, config, and program flows are cluster-configurable: an integrator points
them at the cluster they deploy to. The oracle source, keeper operator, and
liquidity are integrator-owned; the verifiable oracle paths are described in
[`oracle-integration.md`](oracle-integration.md).
