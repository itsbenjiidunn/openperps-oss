//! OpenPerps on-chain program: a Pinocchio wrapper around the percolator
//! v16 risk engine.
//!
//! The engine (crate `percolator`) is Kani-formally-verified upstream and
//! vendored unmodified; this wrapper's independent review status is tracked in
//! SECURITY.md.
//!
//! The engine (crate `percolator`) is a pure, `no_std`, account-local risk
//! library: every operation is a `*_not_atomic` method on in-memory structs.
//! This program owns everything the engine deliberately leaves out: the
//! entrypoint, instruction decoding, account loading/ownership checks,
//! signer authorization, and persisting state back to account data.
#![cfg_attr(target_os = "solana", no_std)]

// The pure HLP share/NAV math in `hlp` carries `#[cfg(kani)]` proof harnesses
// (run in Linux CI, like the engine). Kani provides the `kani` crate.
#[cfg(kani)]
extern crate kani;

pub mod cpi;
pub mod dexamm;
pub mod error;
pub mod hlp;
pub mod inslp;
pub mod instruction;
pub mod processor;
pub mod pyth;
pub mod state;

// The pinocchio `entrypoint!` macro also installs a global allocator and a
// panic handler. Those only make sense for, and only compile cleanly on,
// the on-chain SBF target, so we gate the whole entrypoint there. Host builds
// (and unit tests / shared codec) stay on std.
#[cfg(all(target_os = "solana", not(feature = "no-entrypoint")))]
mod entrypoint;

pub use processor::process_instruction;
