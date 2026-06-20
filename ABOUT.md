# OpenPerps

## Description

OpenPerps is open, permissionless perpetual-futures infrastructure for Solana. Any app can stand up a leveraged long/short market on any token with a single SDK call, and trade it on Percolator v16, the formally-verified risk engine by Anatoly Yakovenko (@toly). The protocol is a neutral commons: trading fees and spread flow to liquidity providers and the market's liquidity vault, not to a protocol middleman. OpenPerps ships in two layers, the open infrastructure (OpenPerps OSS) that any app builds on, and the flagship venue (OpenPerps App) that leads on liquidity and trading experience.

## Problem

Leveraged perps on Solana are concentrated on a handful of major tokens and run by closed venues. The long tail, memecoins, fresh launches, and community tokens, has no way to be longed or shorted. The apps that already list those tokens (launchpads, DEX terminals, swap UIs, Telegram bots, wallets) cannot offer perps without building and auditing a risk engine, an oracle stack, a keeper, and a liquidation system themselves. That is months of work and a permanent security liability, so it never gets built. Where leverage on the long tail does appear, it is on opaque, single-operator products with no formal safety guarantees and no path to composability.

## Solution

OpenPerps ships the entire perp stack as reusable, open infrastructure so an integrator never writes risk code. A market for any token is created with one SDK call (`createPerpMarket`) that classifies the token, picks a risk tier, binds an oracle, seeds the liquidity vault, and emits every instruction. Pricing adapts to the token: Pyth for majors, an on-chain DEX-EWMA reader for tokens with a real pool, and a relayer mode sourced from DexScreener and Jupiter for memecoins. A self-host keeper and the `openperps-relayer` daemon push live marks, funding, and liquidations. Vault liquidity, insurance, and funding are built in, all on a risk engine that is formally verified rather than freshly written.

Integrators choose their path. Run your own stack with `@opp-oss/sdk` for full control, or plug straight into the live OpenPerps App with `@opp-app/connect`, the App kit that wires a bot, launchpad, or terminal into the App's shared markets, vault liquidity, always-on keeper, live prices, and Official Integration listing, with no protocol to run. The App is the power source; connect is the wire. Either way, apps embed as much or as little as they want, from a single long/short button to a full terminal.

## Traction

OpenPerps is a security-hardened perpetual-futures protocol with a live flagship venue and a public, embeddable SDK. What is shipped:

- **A full protocol, deployed and running.** Program covers market creation, the liquidity vault, insurance, funding, and permissionless liquidation, all on top of Percolator v16, the formally-verified risk engine by Anatoly Yakovenko (@toly), vendored unmodified.
- **A live flagship venue.** The OpenPerps App (openperps.fun) lets anyone create a market for any token, long and short, manage positions, and read live marks, built on the exact same open stack every integrator uses.
- **A published, embeddable kit.** The SDK, React widgets, and keeper ship on npm under `@opp-oss`, with six runnable example integrations (token page, DEX terminal, launchpad, wallet card, Telegram bot, node script). Listing a perp on any token is a single SDK call.
- **A one-line path into the live App.** `@opp-app/connect` lets any bot, launchpad, or terminal plug into the running OpenPerps App, its shared markets, vault liquidity, keeper, and live prices, without standing up any infrastructure. Build your own with `@opp-oss`, or wire into the App with `@opp-app`.
- **A hardened wrapper.** Two full security reviews were completed and every finding closed: the oracle-manipulation path, on-chain fee enforcement, vault-withdraw protection, per-market oracle authority, and dependency auditing. The verified engine underneath is untouched.
- **A modeled economy.** An on-chain economic model quantifies liquidity-vault and provider viability across real memecoin scenarios and sets the parameters for the liquidity roadmap.

OpenPerps is the open perp layer for Solana: any app can offer leverage on any token, on a risk core that is formally verified rather than freshly written and unaudited.

## Market and Growth

OpenPerps sits at the intersection of the Solana memecoin and launchpad economy, on-chain perps and leverage, and embeddable DeFi infrastructure. The addressable surface is every Solana app that already shows a token and every trader who wants leverage beyond the majors.

Three channels drive growth:
1. **Developer adoption.** Run your own stack with `@opp-oss`, or take the fast path and plug into the live App with `@opp-app/connect`, so any wallet, terminal, launchpad, or bot embeds perps in days, not months.
2. **The flagship App** as proof and a liquidity magnet, the deepest and best-executed venue under the shared roof.
3. **An Official Integration program** where launchpads, bots, and wallets list against shared, App-seeded liquidity and route flow back, with partners able to provide liquidity, and earn, by backing the vault.

The model is bottom-up and self-propagating: anyone can list a market for any token, and anyone with capital can back the liquidity vault for a market they believe in.

## Use of Funds

Funding accelerates production hardening, liquidity bootstrapping, and ecosystem growth. Monthly allocation:

- **Team: ~$5,000 / month.** Solana and Rust program engineering, TypeScript SDK and keeper, security engineering.
- **Infrastructure: ~$3,000 / month.** Keeper and relayer transaction costs (the dominant operating cost at a fast on-chain mark cadence), Helius RPC and Geyser, indexer hosting.
- **Security and ecosystem: ~$1,500 / month.** Community audit coordination, a bug bounty, developer relations.
- **Marketing and partnerships: ~$1,000 / month.** Integration partners, community incentives.

**Total: ~$10,500 / month.** Runway target: 6 to 12 months depending on round size.

## Roadmap and Milestones

**Live today.** The open perp layer, deployed and running: one-call listing, the three-mode oracle stack, the keeper and relayer daemon, the liquidity vault and insurance, a full security hardening pass, and the flagship App with `@opp-app/connect`. Any app can embed perps on any token, verified end to end.

**Q3 2026, scale the venue.**
- The OpenPerps App leads as the reference venue with the deepest liquidity.
- The Official Integration program opens for launchpads, bots, and wallets.
- External community audit of the wrapper, plus a public bug bounty.
- Pyth feeds and Helius RPC plus Geyser across the keeper fleet.

**Q4 2026, liquidity-native perps for the long tail.**
- Token-collateralized (coin-margined) perps so a token needs no USDC to bootstrap: the token itself is the collateral, the liquidity, and the settlement.
- A dynamic leverage ratchet that tightens margin as a one-sided book fills, bounding vault drawdown from a one-way rush.
- Economic levers that turn volume into liquidity-provider yield (a maker fee routed to the vault, a paid-seed funding model), sized against the on-chain model.

**Q1 2027, beyond perps and into governance.**
- Prediction markets on the same parimutuel settlement core.
- Futarchy and outcome markets, including protocol parameter governance by decision market.
- A broader integration footprint across the Solana app ecosystem.

## Financial Projections

Revenue is fee-driven: trading fees and price-impact spread captured at the flagship App and by the liquidity vaults, with the open protocol taking no cut. Revenue scales with volume across active markets, while the main operating cost, keeper and relayer transaction fees, grows sub-linearly with the number of markets, so margin expands as the venue grows. Because listing is permissionless and the App seeds and curates the deepest markets, the venue compounds: more markets and deeper liquidity draw more flow, and more flow funds deeper liquidity. Full P&L and volume sensitivities are in the data room.

## Token and Governance

The intended design follows the protocol's ethos, return the rents to users:

- The **open protocol stays a neutral commons** and takes no protocol tax. Value accrues to holders from the flagship App's fee revenue and the treasury, not from inflationary emissions.
- **Governance by futarchy.** Decisions over the treasury and non-critical parameters pass through a decision market, where participants stake real capital on whether a proposal raises or lowers token value, so proposals predicted to harm value are rejected.
- **No insider dump.** Team and investor allocations are locked and performance-based, with unlocks tied to time and to price or adoption milestones, not a launch-day cliff.
- Value flows to holders because the venue processes real volume, not because new tokens are printed.


## Links

- Website: https://openperps.fun
- X: https://x.com/openperpsdotfun
- GitHub (OSS): https://github.com/itsbenjiidunn/openperps-oss
- GitHub (App): https://github.com/itsbenjiidunn/openperps
- npm, OSS SDK: https://www.npmjs.com/package/@opp-oss/sdk
- npm, App kit: https://www.npmjs.com/package/@opp-app/connect
