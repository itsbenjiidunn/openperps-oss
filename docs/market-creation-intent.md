# Market Creation Intent

`OpenPerpsMarketCreationIntent` is an SDK format, not one on-chain instruction.

```ts
type OpenPerpsMarketCreationIntent = {
  schemaVersion: 1;
  baseMint: string;
  quoteMint: string;
  symbol: string;
  name?: string;
  initialPrice: string;
  maxLeverage: number;
  riskTier: "major" | "standard" | "experimental";
  priceProvider: { type: "external"; id: string; description?: string };
  lpVault?: { initialDeposit?: string };
};
```

Creating a usable custom market is a composed lifecycle. The pure
`planMarketCreation(intent)` planner describes the ordered steps, and
`buildMarketCreationInstructions(...)` composes them into the on-chain
instructions a caller signs and sends:

```txt
InitMarket
CreateVault
CreateHouseVault
FundHouseVault        (only when lpVault.initialDeposit is provided)
ActivateMarket
CreateMockPool        (optional, test-only price source)
oracle binding
```

- `lpVault.initialDeposit` funds the House/LP counterparty used for matched-cross
  trading.
- `priceProvider.id` is a keeper/integration identifier. It is not a trusted
  price by itself, and the keeper signer must still satisfy the program's oracle
  authority checks.

## Lifecycle test requirement

Before claiming custom market creation complete, add an integration test that
creates a market from intent, creates and funds House/LP, activates it, runs one
keeper/oracle update, opens a trade against House/LP, and asserts state is usable.
