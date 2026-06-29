# OPP Launchpad: launch a token with a perp, seeded by the allocation

When you mint a token you hold a large allocation. The usual move is to lock it. The
launchpad pattern does the opposite: it puts that allocation to work as the liquidity of
a perp on the same token, so the token gets an instant leveraged market with zero USDC.

This is a **coin-margin** market (`quote_mint == base_mint == the token`): collateral,
liquidity, PnL, and settlement are all the token itself. The allocation seeds the House;
traders long/short from day one; the creator earns the House edge instead of holding a
locked, idle bag.

No new on-chain code is involved. `buildLaunchpadPerp` is a thin preset over
`buildPerpMarketListing` that wires the launchpad recipe:

```ts
import { buildLaunchpadPerp } from "@opp-oss/sdk";

const listing = buildLaunchpadPerp({
  programId,
  authority: creator,            // signs creation, seeds the House
  market: marketKeypair.publicKey,
  marketRentLamports: rent,
  token: mint,                   // the freshly launched token (becomes base AND quote)
  symbol: "MYTOKEN",
  launchPriceUsd: 0.0001,        // bonding-curve / fair-launch start price
  allocationAtoms: 1_000_000_000n, // the would-be-locked allocation, in token atoms
  authorityTokenAccount: creatorTokenAccount,
});
// listing.instructions: create market + vault + House, fund House with the allocation,
// activate at the launch price, set the safe coin-margin risk profile. Sign with the
// market keypair (account creation) + the authority, then send.
```

## What you get, by construction

- **Coin-margin, forced safe.** Because `quote_mint == base_mint`, the program forces the
  market to the VOLATILE tier (5x, 20% initial margin) with a wide-clamp / short-window
  oracle so the mark tracks a violent move before it becomes bad debt. The SDK also
  auto-applies the coin-margin risk profile: a House OI cap of 5x equity, a stale-pause,
  and a small impact + skew spread. See [coin-margin](./coin-margin.md) and
  [oracle-hardening](./oracle-hardening.md).
- **Productive, not locked.** The allocation funds the House and earns the House edge.
  The engine refuses a House withdrawal while any position is open, so the seed is
  committed for as long as the market is active. This is a SOFT commitment, not a hard
  timelock: once the market is flat, the creator can withdraw via `WithdrawHouseVault`. A
  rug-proof hard lock would need a program-level timelock (not in this preset).
- **MANUAL at launch, graduate later.** A fresh token has no deep pool, so the market is
  MANUAL-priced at the launch price (a relayer / `oracleAuthority` keeps the mark live)
  and graduates to a verifiable DEX-EWMA crank once a pool is deep enough (`SetDexPool`
  flips `require_verifiable` 0 -> 1, a one-way ratchet).

## One call: mint the token AND launch the perp

`buildLaunchpadPerp` takes an EXISTING mint. To mint the token and launch in one build,
use `buildTokenLaunchWithPerp`: it adds the SPL mint creation, the supply, and an optional
mint-authority revoke (fixed supply), then chains into `buildLaunchpadPerp`.

```ts
import { buildTokenLaunchWithPerp } from "@opp-oss/sdk";
import { MINT_SIZE } from "@solana/spl-token";

const launch = buildTokenLaunchWithPerp({
  programId, authority: creator,
  mint: mintKeypair.publicKey,
  mintRentLamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
  decimals: 6,
  totalSupply: 1_000_000_000_000n,   // minted to the creator
  revokeMintAuthority: true,         // fixed supply (a launch trust signal)
  market: marketKeypair.publicKey,
  marketRentLamports: rent,
  allocationAtoms: 100_000_000_000n, // the slice that seeds the House
  launchPriceUsd: 0.0001,
  symbol: "MYTOKEN",
});
// launch.tokenInstructions  -> sign with [creator, mintKeypair],   send first.
// launch.listing.instructions -> sign with [creator, marketKeypair], send next.
```

It is a pure builder (no network, no sending). Send `tokenInstructions` first so the
creator holds the allocation before the House seed pulls from it, then the launch.

## What it still leaves to the launchpad app

- **Token metadata** (name / symbol / image). The token mints and trades fine without it,
  but it shows up blank in wallets. Pass a Metaplex `CreateMetadataAccountV3` instruction
  as `metadataInstruction` to include it. It is omitted by default because the Metaplex
  program is not present on a bare local validator, so it is a caller-supplied hook.
- **The spot pool** (for spot trading + the eventual DEX-EWMA oracle). Use your AMM /
  bonding curve, then `SetDexPool` to graduate the perp oracle.

## Reflexivity reminder

A fresh token, a perp on it, and collateral that is the token itself is the most
reflexive setup there is. The 5x tier, the OI cap, and the depth gate blunt it, but keep
the launch caps conservative (`houseCapBase`, `depositCapAtoms`) and raise them as the
pool deepens. Proven end to end by `packages/sdk/scripts/launchpad-integration.ts`.
