//! On-chain SBF entrypoint. Compiled only for `target_os = "solana"`.
//!
//! We run fully `no_std`, which rules out pinocchio's `entrypoint!` shortcut
//! (its `default_panic_handler!` only emits a hook and relies on `std` for the
//! real `#[panic_handler]` lang item). The natural replacement,
//! `nostd_panic_handler!`, puts `#[no_mangle]` on the `#[panic_handler]`, which
//! Rust 1.89 (the compiler shipped in Solana platform-tools v1.53) rejects as
//! "`#[no_mangle]` cannot be used on internal language items". Pinocchio 0.9
//! fixes this, but 0.9 requires edition2024 (Cargo ≥1.85), newer than our
//! toolchain. So we keep pinocchio 0.8.4 and hand-write the panic handler,
//! mirroring `nostd_panic_handler!` minus the offending `#[no_mangle]`.

use crate::processor::process_instruction;
use pinocchio::{default_allocator, program_entrypoint};

program_entrypoint!(process_instruction);
default_allocator!();

/// `no_std` panic handler: report the panic location via the Solana syscall and
/// abort. Equivalent to pinocchio's `nostd_panic_handler!`, without the
/// `#[no_mangle]` that Rust 1.89 forbids on lang items.
#[cfg(target_os = "solana")]
#[panic_handler]
fn handle_panic(info: &core::panic::PanicInfo<'_>) -> ! {
    if let Some(location) = info.location() {
        unsafe {
            pinocchio::syscalls::sol_panic_(
                location.file().as_ptr(),
                location.file().len() as u64,
                location.line() as u64,
                location.column() as u64,
            )
        }
    } else {
        pinocchio::log::sol_log("** PANICKED **");
        unsafe { pinocchio::syscalls::abort() }
    }
}
