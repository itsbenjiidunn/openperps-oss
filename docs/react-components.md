# React Components

React components provide a fast integration path for teams that want ready-made
trade, chart, and position UI.

The SDK remains the primary integration surface. Teams can use the SDK directly
to build their own interface, bot, mobile app, or backend flow.

## Planned components

```tsx
<OpenPerpsTrade market={market} />
<OpenPerpsChart market={market} candles={candles} />
<OpenPerpsPosition owner={wallet} market={market} />
<OpenPerpsMarketLauncher intent={marketCreationIntent} />
```

## Data ownership

The host app provides market config, registry provider, wallet adapter, RPC
endpoint, optional theme, optional chart data, and optional callbacks. Chart
candles come from the integrator; OpenPerps renders the chart shell and position
overlays. The components do not require the host app to use the OpenPerps App
layout.
