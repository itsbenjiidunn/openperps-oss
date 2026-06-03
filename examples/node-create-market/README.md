# node-create-market

This example shows how to integrate OpenPerps through `@openperps/sdk`.

## What It Demonstrates

- create a market from an `OpenPerpsMarketCreationIntent`
- register the resulting config in a local JSON registry
- run a keeper against that config

## Run

```bash
npm install
npm start
```

It prints the creation plan and the derived market/vault/House addresses, and
writes `registry.json`. By default it builds and registers without sending, so
it runs without a funded key (it only reads the rent figure from the RPC). Set
`OPENPERPS_RPC` and `OPENPERPS_PROGRAM_ID` to target a different cluster or
deployment.

To create the market on-chain, fund the authority, supply a real quote (USDC)
mint, and sign and send `build.instructions` with `[authority, market]`.

## Boundaries

This example uses a sample Solana cluster configuration and can be adapted for your deployment.
