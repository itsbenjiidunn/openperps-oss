# Engine Upstream Baseline

OpenPerps vendors the Percolator v16 risk engine as its core risk-engine
baseline. The goal is not to claim OpenPerps is upstream Percolator; it is to
keep the fork boundary auditable.

## Current baseline

- upstream: aeyakovenko/percolator
- engine generation: v16.9.0 (per `crates/engine/spec.md`)
- pinned source commit: 91a46c0fbdee4fbecd178524e7759144ba336f62 (branch master)
- synced: 2026-06-24

The engine sources are vendored byte-for-byte:
`crates/engine/src/v16.rs`, `src/lib.rs`, `src/wide_math.rs`, `spec.md`,
`tests/`, and `kani-list.json`. They are not hand-modified.

## Wrapper-specific adaptations

Only `crates/program` (the OpenPerps Solana wrapper) is adapted to the engine's
current API. Adaptations:

- **SettlePnl.** Upstream removed `settle_realized_pnl_not_atomic` (the old
  vault-debit settle) and replaced it with the single-account
  `convert_released_pnl_to_capital_not_atomic`. The wrapper's `settle_pnl_buffer`
  now calls the convert primitive, and the `SettlePnl` instruction dropped its
  vault account (also dropped from `settlePnlIx` in `packages/sdk`). The realizable
  amount is backed by the source-credit the engine reserved from the
  counterparty at open time, so no vault account is touched at settle.

## Update procedure

When re-vendoring a newer upstream engine:

1. Copy the upstream engine files byte-for-byte into `crates/engine`.
2. Build `cargo build -p openperps-program` and adapt only `crates/program` to
   any changed engine API.
3. Verify account layout is unchanged with
   `cargo test -p openperps-program print_byte_sizes_for_sdk -- --nocapture`
   (the offsets must still match `packages/sdk/src/layout.ts`).
4. Verify behavior with `cargo test -p openperps-program`.
5. Update the pinned commit above and add a short note describing what changed
   from upstream and any new wrapper adaptation.

Upstream rebases its history, so pin by recording the commit SHA here rather
than assuming old SHAs remain reachable.
