# Security And Limitations

OpenPerps v1 is devnet-default and mainnet-capable, but not production-approved.

Unaudited means OpenPerps has not yet received an independent third-party
security and risk review.

An audit should cover:

- Solana account validation
- signer and authority checks
- PDA derivation and ownership assumptions
- SPL token custody and CPI flows
- deposit and withdraw safety
- delegate/session key permissions
- trade, PnL, funding, and settlement logic
- liquidation correctness
- oracle authority, stale price, and manipulation assumptions
- keeper reliability assumptions
- LP and insurance vault risk
- custom SPL market risk

Do not use with real user funds unless you complete your own review and accept
the risk.

The current authority-pushed oracle trust model is the first mainnet blocker to
remove. Custom SPL markets are experimental: integrators are responsible for
price source quality and for LP and insurance liquidity, and keeper reliability
matters for liquidation safety.
