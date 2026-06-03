//! Hand-rolled CPI helpers for the System program and SPL Token v1.
//!
//! We avoid `pinocchio-token` / `pinocchio-system` to keep our dependency
//! tree under control, both have rolled their MSRVs past what our
//! Cargo.lock supports. The instruction layouts here are trivial (a few
//! bytes each); reproducing them in-tree is cheaper than untangling
//! edition2024 transitive constraints.

use pinocchio::{
    account_info::AccountInfo,
    cpi::{invoke, invoke_signed},
    instruction::{AccountMeta, Instruction, Signer},
    pubkey::Pubkey,
    ProgramResult,
};

/// SPL Token program (v1, the original `Tokenkeg...`).
/// Pubkey: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
pub const TOKEN_PROGRAM_ID: Pubkey = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133,
    237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];

/// Solana System program (all-zero pubkey).
pub const SYSTEM_PROGRAM_ID: Pubkey = [0u8; 32];

// ---------- System.CreateAccount ----------

/// Invoke `System::CreateAccount`, signed for the `new_account` via the
/// given seeds (so the new account can be a PDA owned by our program).
///
/// Layout: tag(u32 LE = 0) | lamports(u64 LE) | space(u64 LE) | owner([u8;32]).
pub fn system_create_account<'a>(
    payer: &'a AccountInfo,
    new_account: &'a AccountInfo,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
    signer_seeds: &[Signer<'_, '_>],
) -> ProgramResult {
    let mut data = [0u8; 4 + 8 + 8 + 32];
    // tag = 0 (CreateAccount); data[0..4] already zero.
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner);
    let accounts = [
        AccountMeta::new(payer.key(), true, true),
        AccountMeta::new(new_account.key(), true, true),
    ];
    let ix = Instruction {
        program_id: &SYSTEM_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke_signed::<2>(&ix, &[payer, new_account], signer_seeds)
}

// ---------- SPL Token.InitializeAccount3 ----------

/// Invoke `Token::InitializeAccount3(owner)`: initialize an already-allocated
/// account as an SPL token account for `mint`, with `owner` as the authority
/// allowed to sign transfers out. Skips the Rent sysvar that
/// `InitializeAccount` (v1/v2) require.
///
/// Layout: tag(u8 = 18) | owner([u8;32]).
pub fn token_initialize_account3<'a>(
    account: &'a AccountInfo,
    mint: &'a AccountInfo,
    owner: &Pubkey,
) -> ProgramResult {
    let mut data = [0u8; 1 + 32];
    data[0] = 18;
    data[1..33].copy_from_slice(owner);
    let accounts = [
        AccountMeta::new(account.key(), true, false),
        AccountMeta::readonly(mint.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke::<2>(&ix, &[account, mint])
}

// ---------- SPL Token.Transfer ----------

/// Invoke `Token::Transfer(amount)` with `authority` as a regular signer
/// (used for user-initiated deposits into the vault).
///
/// Layout: tag(u8 = 3) | amount(u64 LE).
pub fn token_transfer<'a>(
    source: &'a AccountInfo,
    destination: &'a AccountInfo,
    authority: &'a AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 1 + 8];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let accounts = [
        AccountMeta::new(source.key(), true, false),
        AccountMeta::new(destination.key(), true, false),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke::<3>(&ix, &[source, destination, authority])
}

/// Same as [`token_transfer`] but signed by a PDA via `signer_seeds`
/// (used for withdraw, where the vault PDA is the token-account authority).
pub fn token_transfer_signed<'a>(
    source: &'a AccountInfo,
    destination: &'a AccountInfo,
    authority: &'a AccountInfo,
    amount: u64,
    signer_seeds: &[Signer<'_, '_>],
) -> ProgramResult {
    let mut data = [0u8; 1 + 8];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let accounts = [
        AccountMeta::new(source.key(), true, false),
        AccountMeta::new(destination.key(), true, false),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke_signed::<3>(&ix, &[source, destination, authority], signer_seeds)
}
