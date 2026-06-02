# Security

## Reporting a vulnerability

Report security issues privately, not in public issues or pull requests. Use
GitHub's private vulnerability reporting on this repository (**Security** tab →
**Report a vulnerability**), or contact the maintainer directly. Please include a
description, the affected component, and reproduction steps. Issues are
acknowledged and fixed before any public disclosure.

## Scope

In scope: the on-chain program (`crates/program`), the SDK (`packages/sdk`), the
React kit (`packages/react`), and the keeper (`packages/keeper`).

Out of scope (vendored upstream): the Percolator risk engine in `crates/engine`
is vendored byte-for-byte from upstream and is Kani-formally-verified there.
Engine findings belong upstream; this repo does not modify it.

## Trust boundary

Verified: the Percolator risk engine (market isolation, margin, and settlement
math) is formally verified upstream and vendored unmodified.

Not verified: everything OpenPerps OSS adds around it. The program wrapper (SPL
custody, vault PDAs, the House vault, `PlaceOrder` / `Withdraw` / `Liquidate`,
oracle cranks, market metadata), the SDK, and the keeper have not had an
independent third-party audit.

Owned by the integrator: a deployment configures its own oracle source, keeper
operator, liquidity and risk parameters, and market registry. Putting a
deployment in front of real users is the deploying team's decision and review.

See [`docs/security-and-limitations.md`](docs/security-and-limitations.md),
[`docs/oracle-and-price-safety.md`](docs/oracle-and-price-safety.md), and
[`docs/deployment-checklist.md`](docs/deployment-checklist.md).
