# token-page

This example shows how to integrate OpenPerps through `@openperps/sdk`.

## What It Demonstrates

- map a single token page to a single market config
- embed a trade widget
- embed a position widget

## Run

```bash
npm install
npm run dev      # or: npm run build
```

Open the printed URL, connect a devnet wallet, and you get the chart, a
Long/Short widget, and your position, all from `@openperps/react` against one
market config. [`src/App.tsx`](src/App.tsx) is the whole integration. A trade
needs an initialized, funded portfolio; deposit devnet USDC through
`@openperps/sdk` first.

## Boundaries

This example targets Solana devnet.
