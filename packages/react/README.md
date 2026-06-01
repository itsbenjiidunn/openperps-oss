# @openperps/react

Drop-in React components and hooks for embedding OpenPerps trading, charts, and
positions. Built on [`@openperps/sdk`](../sdk) and the Solana wallet adapter.

The SDK is the primary integration surface; these components are the fast path
for teams that want ready-made UI. `react`, `@solana/web3.js`, and
`@solana/wallet-adapter-react` are peer dependencies, so the components use your
app's existing wallet and connection providers.

## Components

```tsx
import {
  OpenPerpsTrade,
  OpenPerpsPosition,
  OpenPerpsChart,
  OpenPerpsMarketLauncher,
} from "@openperps/react";

<OpenPerpsTrade market={market} counterparty={house} executionPrice={mark} />
<OpenPerpsPosition market={market} owner={wallet.publicKey} />
<OpenPerpsChart market={market} candles={candles} />
<OpenPerpsMarketLauncher intent={creationIntent} onLaunch={createMarket} />
```

The host app provides the market config, the resolved House/LP counterparty, the
execution price (from the keeper/on-chain mark, never a client chart price), and
chart candles. The components ship no CSS; style them through `className` or the
default `openperps-*` class names.

## Headless

Skip the UI and drive a trade with the hook:

```tsx
import { useOpenPerpsTrade } from "@openperps/react";

const { placeTrade, pending, error } = useOpenPerpsTrade({ market, counterparty });

await placeTrade({ side: "long", size: "1000000", executionPrice: mark });
```

`placeTrade` resolves the intent (counterparty, limit, slippage, reduce-only
guards), builds the `PlaceOrder` transaction, signs it with the connected
wallet, and confirms it.

## License

MIT.
