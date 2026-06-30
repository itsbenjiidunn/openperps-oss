# Launch aggregator: one flow, any launchpad, plus a perp

OpenPerps acts as a **non-custodial launch intermediary**. A dev picks a token origin
(native mint, Pump.fun, LetsBonk), launches the token *through* OpenPerps, and the same
wallet flow stands up a **coin-margin perp** on that token. The dev's own wallet signs
every step; OpenPerps only orchestrates.

This is the app layer (`apps/web/src/lib/launch/`), not the OSS SDK: the external launchpads
are off-chain HTTP APIs with keys and IPFS, so they cannot live in the dependency-light,
no-network `@opp-oss/sdk`. The perp itself is the SDK's `buildLaunchpadPerp`.

## Providers (token origin)

| Provider | Backend | Token + spot | Perp seed |
|---|---|---|---|
| `native` | OpenPerps mints the SPL token | full supply to the creator; optional real LP pool (below) | a slice of the supply |
| `pumpfun` | PumpPortal local API, `pool: "pump"` | Pump.fun bonding curve | the dev-buy bag |
| `bonk` | PumpPortal local API, `pool: "bonk"` | LetsBonk (Raydium LaunchLab) curve | the dev-buy bag |
| `bags` | not yet wired (scaffold slot) | - | - |

Pump/Bonk go through PumpPortal's **local transaction API** (`POST /api/trade-local`, no API
key): it returns a serialized `create` (+ optional dev-buy) transaction that the dev's
wallet co-signs with the fresh mint keypair. The dev-bought bag is what seeds the perp.

## The flow

Each step is one wallet approval (`aggregatorLaunch` in `aggregatorFlow.ts`):

1. **upload** - when an image is given, pin the metadata JSON to IPFS (external launchpads
   require a metadata URI before the create tx). Pluggable uploader; Pinata by default.
2. **deploy** - the provider's create (+ dev-buy) transaction(s).
3. **add-lp** *(optional, native)* - create a real spot pool at the chosen venue.
4. **seed-perp** - create the coin-margin market + House, fund it from the bag, activate at
   the launch price (`buildLaunchpadPerp`). Coin-margin forces the VOLATILE 5x tier.
5. **commit** *(optional)* - `SetHouseLock` to rug-proof the seed behind a slot timelock.

The perp seed is sized as a fraction of the dev-buy bag (external) or an explicit token
amount (native), read from the creator's on-chain balance after the deploy / LP.

## Spot LP (native): multi-venue, dev chooses

When a token is minted natively (no external bonding curve), the dev can add a real spot
pool so the token is instantly spot-tradeable and routable (Jupiter, dexscreener). The
venue is a `SpotPoolProvider` (`spotPool.ts`); the dev chooses:

- **Raydium CPMM** - wired (`raydiumCpmm.ts`), token/SOL, via `@raydium-io/raydium-sdk-v2`.
- **Meteora DLMM**, **Orca Whirlpools** - recognised + selectable, but gated (their SDKs
  are not wired yet; `createPool` throws with the dep to install). The abstraction is ready
  for them.

The Raydium SDK + `bn.js` are loaded **lazily**, so they are not bundled into the launchpad
page (verified: the `/launchpad` chunk stays ~10 kB gzip) and only load when a dev actually
creates a pool.

### Why a token/SOL pool is NOT auto-bound as the perp oracle

The program's DEX-EWMA reader (`crates/program/src/dexamm.rs`) is AMM-agnostic: it reads the
`amount` of the pool's two SPL vaults (the format Raydium CPMM keeps reserves in), so
`SetDexPool` *can* pin a real Raydium pool on mainnet. **But** `cp_spot_to_mark` assumes the
quote vault is the 6-decimal USD collateral. A token/**SOL** pool's quote is WSOL (9dp), so
its EWMA prices the token in **SOL, not USD**. Binding it would give a SOL-denominated mark
that diverges from the perp's USD launch price.

So the aggregator keeps the launched perp **MANUAL** (the `oracleAuthority` maintains the
mark) and does **not** auto-graduate a token/SOL pool. Oracle graduation via `SetDexPool` is
a deliberate, separate step that only yields a correct USD mark from a **token/USDC** pool.

## Config

- `VITE_PINATA_JWT` - Pinata API JWT (operator secret) used to pin the image + metadata
  JSON. Required for Pump/Bonk (they need a metadata URI); optional for native.
- `@raydium-io/raydium-sdk-v2` + `bn.js` - installed for the Raydium LP venue.

## File map

```
apps/web/src/lib/launch/
  types.ts          LaunchProvider, DeployPlan, TokenLaunchRequest
  providers.ts      registry: native, pumpfun, bonk
  native.ts         native mint provider (full supply to creator)
  pumpportal.ts     Pump.fun + LetsBonk via PumpPortal local API
  ipfs.ts           pluggable metadata uploader (Pinata default)
  spotPool.ts       SpotPoolProvider registry (raydium wired; meteora/orca scaffold)
  raydiumCpmm.ts    Raydium CPMM token/SOL adapter (lazy SDK import)
  aggregatorFlow.ts the orchestration (upload -> deploy -> add-lp -> seed-perp -> commit)
apps/web/src/components/openperps/LaunchpadPanel.tsx   the /launchpad UI
```

## Verification status (be honest)

- **Verified locally:** typecheck clean; production `vite build` succeeds; the lazy Raydium
  import keeps the launchpad chunk small.
- **NOT verified (mainnet + keys only):** Pump.fun / LetsBonk create via PumpPortal (no
  devnet for them) and Raydium pool creation (~0.15+ SOL on mainnet) are live-unverified
  here. The encodings follow each provider's documented contract; run a mainnet dry-run with
  a funded wallet (and a Pinata JWT) before relying on them. The Metaplex metadata path *is*
  verified on devnet (see [launchpad.md](./launchpad.md)).
