# Trade Intent

`OpenPerpsTradeIntent` is the shared order format between UIs, bots, DEX
terminals, and backends. It is an SDK format, not an on-chain order type.

```ts
type OpenPerpsTradeIntent = {
  schemaVersion: 1;
  marketId: string;
  side: "long" | "short";
  size: string;
  limitPrice?: string;
  maxSlippageBps?: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
};
```

`size` is position size in base units after applying `sizeDecimals`; it is not
margin. Margin comes from capital already deposited in the user's portfolio.

Execution price must resolve from keeper-certified/on-chain mark state, not from
client chart data.

`limitPrice`, `maxSlippageBps`, and `reduceOnly` are SDK-side guards in v1, not
native on-chain orderbook semantics:

- `limitPrice` rejects an execution price outside the user's guard
- `maxSlippageBps` rejects an execution price too far from the reference price
- `reduceOnly` rejects an order that would open or increase exposure

`clientOrderId` is client-side correlation metadata and is not enforced on-chain.
