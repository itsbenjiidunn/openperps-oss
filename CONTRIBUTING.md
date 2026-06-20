# Contributing to OpenPerps OSS

How to get a working dev environment and ship changes. For what the project is and
the full feature tour, read the [README](./README.md).

## Prerequisites

- **Node 22** (the toolchain needs >= 20.19 / 22.12).
- **Rust** stable (`rustup`) for the on-chain program and the engine tests.
- **Solana CLI** (`solana`, `solana-keygen`) for devnet work and the on-chain suite.
- **cargo-build-sbf** only if you build the deployable program. On Windows the
  platform-tools rust must be >= 1.79; on Linux/CI the default toolchain works.

## Get started

```bash
git clone https://github.com/itsbenjiidunn/openperps-oss-private.git
cd openperps-oss-private

npm install        # links the @opp-oss/* workspace packages
npm run build      # builds sdk, then react, then keeper (order matters)
npm test           # builds the sdk, then runs each package's tests
npm run typecheck  # type-checks every package
```

`packages/*` is an npm workspace; `react` and `keeper` depend on the compiled
`@opp-oss/sdk`, so the root scripts always build the SDK first. Run `npm run build`
once at the root before building the apps or examples (they consume the packages
locally).

### Rust program and engine

```bash
cargo test -p openperps-program             # production-default build (no devnet handlers)
cargo test -p openperps-program --features devnet   # include the devnet-only handlers
```

Production is the **default** cargo feature: a plain build excludes the devnet-only
price toy and mock handlers, so a mainnet artifact cannot ship them. Build the
devnet artifact explicitly with `--features devnet`.

## Local devnet setup

Most development needs no secrets. To run against devnet you need your own funded
keypair and an RPC URL.

```bash
# 1. Your own devnet keypair (do NOT reuse the program upgrade authority).
solana-keygen new -o ./payer.json
solana airdrop 2 $(solana-keygen pubkey ./payer.json) --url devnet

# 2. Environment.
cp .env.example .env
# edit .env: set OPENPERPS_RPC, OPENPERPS_PAYER=./payer.json, etc.
```

The program id is public (`DEVNET_PROGRAM_ID` is exported from the SDK), so you do
not need anyone else's keys to read state, deposit, or trade on devnet.

## Running the pieces

- **On-chain integration suite** (builds the program, spins up a local
  `solana-test-validator`, deploys, runs the integration scripts):
  ```bash
  npm run onchain-suite           # build + run the full suite
  SKIP_BUILD=1 npm run onchain-suite   # reuse an existing target/deploy/*.so
  ```
- **Keeper / relayer daemon** (pushes a live mark on-chain for relayer markets):
  ```bash
  OPENPERPS_RPC=https://api.devnet.solana.com \
  OPENPERPS_KEEPER_KEYPAIR=./keeper.json \
  OPENPERPS_MARKETS=./markets.json \
  npm run relayer -w @opp-oss/keeper
  ```
- **Economic model report** (vault / HLP break-even simulation):
  ```bash
  npm run report -w @opp-oss/sim
  ```
- **Build the deployable program** (needs the Solana toolchain):
  ```bash
  cargo build-sbf --manifest-path crates/program/Cargo.toml --features devnet   # devnet
  cargo build-sbf --manifest-path crates/program/Cargo.toml                     # production
  ```

## Secrets policy

Never commit secrets, even to this private repo. Git history is permanent, so a
committed secret is burned and must be rotated. `.gitignore` already excludes
`.env` and `*-keypair.json`; keep it that way.

- **Your devnet keypair**: generate your own (above). Each dev uses their own.
- **`.env` values** (`RELAYER_SECRET`, `ADMIN_SECRET`, RPC keys): get them from the
  team's shared password manager / vault, not from git.
- **The program upgrade authority keypair** (controls the live devnet program):
  stays in a vault and is never shared via git. You do not need it to develop. If a
  controlled deploy is required, prefer moving the upgrade authority to a Squads
  multisig over passing the keypair around.

## Contributing changes

- Branch off `main`, open a PR, keep commits focused.
- Run `npm run build && npm test && npm run typecheck` (and `cargo test -p
  openperps-program` for program changes) before pushing.
- `crates/engine` is a vendored, formally-verified copy of Percolator and is not
  modified here; adapt only the wrapper in `crates/program`.
- Project style: no em-dash in prose, comments, or copy. Use periods, commas, colons,
  or parentheses.

## The npm packages

The OSS packages publish under the `@opp-oss` scope: `@opp-oss/sdk`,
`@opp-oss/react`, `@opp-oss/keeper`. The `@opp-oss/sim` package is private (a
research model, not published).
