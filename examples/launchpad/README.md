# launchpad

This example shows how to integrate OpenPerps through `@openperps/sdk`.

## What It Demonstrates

- create a custom market for a launching token
- embed a trade widget on the token launch page
- embed a chart shell with integrator-provided candles
- show the user's position

## Run

```bash
npm install
npm run dev      # or: npm run build
```

`src/App.tsx` is the whole integration, built on `@openperps/react`.

## Boundaries

This example uses a sample Solana cluster configuration and can be adapted for your deployment.
