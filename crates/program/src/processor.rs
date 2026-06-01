//! Instruction dispatch and handlers.

use percolator::v16::{MarketGroupV16ViewMut, PortfolioV16ViewMut};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{create_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    cpi::{
        system_create_account, token_initialize_account3, token_transfer, token_transfer_signed,
        TOKEN_PROGRAM_ID,
    },
    error::{OpenPerpsError, V16ResultExt},
    instruction::OpenPerpsInstruction,
    state::{
        accrue_asset_buffer, activate_market_buffer, crank_oracle_buffer, crank_refresh_buffer,
        deposit_buffer, init_market_buffer, init_mock_pool_buffer, init_portfolio_buffer,
        liquidate_buffer, market_engine_split_mut, market_header, market_wrapper_header,
        delegate_of, mock_pool_spot_price, mock_pool_swap_buffer, portfolio_account_size,
        portfolio_split_mut, resolve_market_buffer, set_delegate_buffer, set_slot_oracle_pool,
        settle_pnl_buffer, slot_oracle_pool, trade_buffer, withdraw_buffer, DelegateAccount,
        DELEGATE_SEED,
        HOUSE_SEED, PORTFOLIO_SEED, VAULT_SEED,
    },
};

/// SPL Token v1 account data length (fixed).
const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

/// The only key allowed to MOVE a market's mark via AccrueAsset (see the oracle
/// gate in `process_accrue_asset`). This is the off-chain price relayer's
/// keypair; delta-0 accruals (stale-lock clears) stay permissionless. Rotating
/// the relayer key requires a program upgrade.
/// `8C6zm6vmyk7kiNxGDQze62DdsfFJC7zbZF8FwFBsvXKP`
const ORACLE_AUTHORITY: Pubkey = [
    106, 217, 250, 24, 98, 232, 106, 23, 98, 81, 231, 177, 129, 19, 153, 186, 245, 127, 20, 230,
    67, 118, 117, 89, 222, 228, 165, 212, 72, 230, 40, 138,
];

/// Per-portfolio collateral ceiling (quote atoms, 6 decimals = $1,000) on a
/// DEX-priced (memecoin) market. Caps the largest position any one account can
/// hold (collateral × leverage), which bounds the profit an attacker can extract
/// by manipulating the underlying thin pool — the economic backstop behind the
/// EWMA mark + per-slot move clamp. Majors (oracle_kind != DEX_EWMA) are exempt.
/// Crude-but-safe global value; the precise form is a per-market cap scaled to
/// live pool depth. Tune up as pools deepen.
const MAX_CUSTOM_PORTFOLIO_CAPITAL: u128 = 1_000_000_000;

/// Entry point body: decode the instruction and route it to a handler.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match OpenPerpsInstruction::unpack(instruction_data)? {
        OpenPerpsInstruction::InitMarket {
            market_group_id,
            asset_slot_capacity,
            vault_bump,
            base_mint,
            oracle_kind,
            oracle_feed_id,
            oracle_pool,
        } => process_init_market(
            program_id,
            accounts,
            market_group_id,
            asset_slot_capacity,
            vault_bump,
            base_mint,
            oracle_kind,
            oracle_feed_id,
            oracle_pool,
        ),
        OpenPerpsInstruction::InitPortfolio { bump } => {
            process_init_portfolio(program_id, accounts, bump)
        }
        OpenPerpsInstruction::Deposit { amount } => {
            process_deposit(program_id, accounts, amount)
        }
        OpenPerpsInstruction::ActivateMarket {
            asset_index,
            authenticated_price,
        } => process_activate_market(program_id, accounts, asset_index, authenticated_price),
        OpenPerpsInstruction::AccrueAsset {
            asset_index,
            effective_price,
            funding_rate_e9,
        } => process_accrue_asset(
            program_id,
            accounts,
            asset_index,
            effective_price,
            funding_rate_e9,
        ),
        OpenPerpsInstruction::Trade {
            asset_index,
            size_q,
            exec_price,
            fee_bps,
        } => process_trade(program_id, accounts, asset_index, size_q, exec_price, fee_bps),
        OpenPerpsInstruction::CreateVault => process_create_vault(program_id, accounts),
        OpenPerpsInstruction::Withdraw { amount } => {
            process_withdraw(program_id, accounts, amount)
        }
        OpenPerpsInstruction::Liquidate {
            asset_index,
            close_q,
            fee_bps,
        } => process_liquidate(program_id, accounts, asset_index, close_q, fee_bps),
        OpenPerpsInstruction::ResolveMarket => process_resolve_market(program_id, accounts),
        OpenPerpsInstruction::CrankRefresh {
            asset_index,
            effective_price,
            funding_rate_e9,
        } => process_crank_refresh(
            program_id,
            accounts,
            asset_index,
            effective_price,
            funding_rate_e9,
        ),
        OpenPerpsInstruction::CreateHouseVault { house_bump } => {
            process_create_house_vault(program_id, accounts, house_bump)
        }
        OpenPerpsInstruction::FundHouseVault { amount } => {
            process_fund_house_vault(program_id, accounts, amount)
        }
        OpenPerpsInstruction::WithdrawHouseVault { amount } => {
            process_withdraw_house_vault(program_id, accounts, amount)
        }
        OpenPerpsInstruction::PlaceOrder {
            side,
            asset_index,
            size_q,
            exec_price,
            fee_bps,
        } => process_place_order(
            program_id,
            accounts,
            side,
            asset_index,
            size_q,
            exec_price,
            fee_bps,
        ),
        OpenPerpsInstruction::CreateMockPool {
            reserve_base,
            reserve_quote,
        } => process_create_mock_pool(program_id, accounts, reserve_base, reserve_quote),
        OpenPerpsInstruction::MockSwap {
            amount_in,
            base_to_quote,
        } => process_mock_swap(program_id, accounts, amount_in, base_to_quote),
        OpenPerpsInstruction::CrankOracle { asset_index } => {
            process_crank_oracle(program_id, accounts, asset_index)
        }
        OpenPerpsInstruction::PinOraclePool { asset_index } => {
            process_pin_oracle_pool(program_id, accounts, asset_index)
        }
        OpenPerpsInstruction::SetDelegate { delegate, bump } => {
            process_set_delegate(program_id, accounts, delegate, bump)
        }
        OpenPerpsInstruction::SettlePnl => process_settle_pnl(program_id, accounts),
    }
}

fn process_init_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    market_group_id: [u8; 32],
    asset_slot_capacity: u32,
    vault_bump: u8,
    base_mint: [u8; 32],
    oracle_kind: u8,
    oracle_feed_id: [u8; 32],
    oracle_pool: [u8; 32],
) -> ProgramResult {
    let [market, authority, quote_mint, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Derive the vault PDA on-chain so the bump the client passed actually
    // produces a valid address for [VAULT_SEED, market.key()].
    let market_key = *market.key();
    let vault = create_program_address(
        &[VAULT_SEED, market_key.as_ref(), &[vault_bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    init_market_buffer(
        &mut data,
        market_group_id,
        asset_slot_capacity,
        *authority.key(),
        *quote_mint.key(),
        vault,
        vault_bump,
        base_mint,
        oracle_kind,
        oracle_feed_id,
        oracle_pool,
    )?;
    Ok(())
}

fn process_init_portfolio(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    bump: u8,
) -> ProgramResult {
    let [portfolio, market, owner, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !owner.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let (market_group_id, asset_slot_capacity) = {
        let m_data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let h = market_header(&m_data)?;
        (h.market_group_id, h.asset_slot_capacity.get() as usize)
    };
    if market_group_id == [0u8; 32] {
        return Err(OpenPerpsError::UninitializedAccount.into());
    }

    // The portfolio lives at the deterministic PDA [PORTFOLIO_SEED, owner,
    // market]: one account per (owner, market), re-derivable on any device with
    // no stored keypair. Verify the supplied address + bump, then create the
    // account ourselves (the PDA signs via invoke_signed) so the client never
    // holds a portfolio key.
    let owner_key: [u8; 32] = *owner.key();
    let market_key = *market.key();
    let derived = create_program_address(
        &[PORTFOLIO_SEED, owner_key.as_ref(), market_key.as_ref(), &[bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *portfolio.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    let portfolio_size = portfolio_account_size(asset_slot_capacity)?;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(portfolio_size);
    let bump_arr = [bump];
    let seeds = [
        Seed::from(PORTFOLIO_SEED),
        Seed::from(owner_key.as_ref()),
        Seed::from(market_key.as_ref()),
        Seed::from(bump_arr.as_ref()),
    ];
    let signer = Signer::from(seeds.as_ref());
    system_create_account(
        owner,
        portfolio,
        lamports,
        portfolio_size as u64,
        program_id,
        &[signer],
    )?;

    // Engine provenance id reuses the PDA bytes so the account is fully
    // deterministic from (owner, market).
    let portfolio_pda_bytes = *portfolio.key();
    let mut pf_data = portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    init_portfolio_buffer(&mut pf_data, market_group_id, portfolio_pda_bytes, owner_key)
        .map_v16()?;
    Ok(())
}

fn process_activate_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    authenticated_price: u64,
) -> ProgramResult {
    let [market, authority, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Pull the current slot from the Clock sysvar via syscall (no Clock account
    // needs to be passed in by the caller).
    let now_slot = Clock::get()?.slot;

    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    // Permissionless listing on the shared market group: any signer may claim
    // a free (Disabled) slot and activate it. The engine still allows the
    // Disabled→Active transition only once per slot, so no re-activation
    // griefing. (No authority pin — see PinOraclePool / permissionless launch.)
    {
        let wrapper = crate::state::market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
    }
    activate_market_buffer(&mut data, asset_index, authenticated_price, now_slot).map_v16()?;
    Ok(())
}

fn process_accrue_asset(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    effective_price: u64,
    funding_rate_e9: i128,
) -> ProgramResult {
    let [market, authority, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let now_slot = Clock::get()?.slot;
    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    {
        let wrapper = crate::state::market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
    }
    // ORACLE GATE (anti-manipulation): only the trusted oracle relayer may MOVE
    // a market's mark. Any other signer is FORCED to a delta-0 accrual — we
    // ignore their requested price/funding and re-assert the current on-chain
    // effective_price. This keeps the permissionless stale-loss-lock clear the
    // trade flow prepends (it only needs to advance `slot_last`) working with no
    // race, while making it impossible for an attacker to walk the mark (clamped
    // or not) and drain the House. Forcing delta-0 (rather than rejecting a
    // mismatch) avoids a TOCTOU race where the relayer moves the price between
    // the client reading it and the tx landing. (Devnet/early-mainnet trust
    // model: a pinned relayer key; the trustless variant sources the price from
    // the on-chain DEX pool via CrankOracle.)
    let is_oracle = *authority.key() == ORACLE_AUTHORITY;
    let (effective_price, funding_rate_e9) = if is_oracle {
        (effective_price, funding_rate_e9)
    } else {
        let current_eff = {
            let (_, markets) = crate::state::market_engine_split_mut(&mut data)?;
            markets
                .get(asset_index as usize)
                .ok_or(OpenPerpsError::InvalidAccountData)?
                .engine
                .asset
                .effective_price
                .get()
        };
        (current_eff, 0)
    };
    // Asserts protective progress so it works once positions are open (the
    // engine still enforces the per-slot price-move bound).
    accrue_asset_buffer(
        &mut data,
        asset_index,
        now_slot,
        effective_price,
        funding_rate_e9,
        /* protective */ true,
    )
    .map_v16()?;
    Ok(())
}

fn process_resolve_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [market, authority, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let resolved_slot = Clock::get()?.slot;
    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    {
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.authority != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
    }
    resolve_market_buffer(&mut data, resolved_slot).map_v16()?;
    Ok(())
}

fn process_crank_refresh(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    effective_price: u64,
    funding_rate_e9: i128,
) -> ProgramResult {
    let [market, portfolio, cranker, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    // Permissionless — any signer pays tx fee and drives progress.
    if !cranker.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { portfolio.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let now_slot = Clock::get()?.slot;
    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut portfolio_data = portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    crank_refresh_buffer(
        &mut market_data,
        &mut portfolio_data,
        now_slot,
        asset_index,
        effective_price,
        funding_rate_e9,
    )
    .map_v16()?;
    Ok(())
}

fn process_liquidate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    close_q: u128,
    fee_bps: u64,
) -> ProgramResult {
    let [market, portfolio, liquidator, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    // Permissionless: any signer can call. We just require *some* signer
    // for tx-fee accountability and so the runtime accepts the tx.
    if !liquidator.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { portfolio.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut portfolio_data = portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    // Engine rejects with NonProgress when the account is still healthy
    // (certified_liq_deficit == 0). Surface that through to the caller via
    // the V16 → ProgramError map.
    let _outcome = liquidate_buffer(
        &mut market_data,
        &mut portfolio_data,
        asset_index,
        close_q,
        fee_bps,
    )
    .map_v16()?;
    Ok(())
}

fn process_withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u128,
) -> ProgramResult {
    let [market, portfolio, owner, vault_token, user_token, _token_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !owner.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !portfolio.is_writable()
        || !vault_token.is_writable()
        || !user_token.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { portfolio.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Vault must match wrapper-recorded PDA; capture bump for invoke_signed.
    let vault_bump = {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if *vault_token.key() != wrapper.vault {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        wrapper.vault_bump
    };

    let amount_u64: u64 = amount
        .try_into()
        .map_err(|_| OpenPerpsError::ArithmeticOverflow)?;

    // Engine first: debit capital / vault / c_tot. If the portfolio still has
    // open positions or negative pnl the engine rejects before we ever move
    // any tokens — clean atomic semantics.
    {
        let mut market_data = market
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let mut portfolio_data = portfolio
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        // Owner check against the portfolio header.
        {
            let (p_header, _) = portfolio_split_mut(&mut portfolio_data)?;
            if p_header.owner != *owner.key() {
                return Err(OpenPerpsError::MissingRequiredSignature.into());
            }
        }
        withdraw_buffer(&mut market_data, &mut portfolio_data, amount).map_v16()?;
    }

    // Then move tokens out: vault PDA signs as the TokenAccount authority.
    if amount_u64 > 0 {
        let market_key = *market.key();
        let bump = [vault_bump];
        let seeds = [
            Seed::from(VAULT_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(bump.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        token_transfer_signed(
            vault_token,
            user_token,
            vault_token, // same PDA is both the source TokenAccount AND its authority
            amount_u64,
            &[signer],
        )?;
    }
    Ok(())
}

fn process_create_vault(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [market, authority, vault, quote_mint, _system_program, _token_program, ..] = accounts
    else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !vault.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Read wrapper metadata and confirm everything lines up.
    let (vault_bump, expected_quote_mint, expected_vault) = {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.authority != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
        (wrapper.vault_bump, wrapper.quote_mint, wrapper.vault)
    };
    if *vault.key() != expected_vault {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if *quote_mint.key() != expected_quote_mint {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    // Allocate the vault account at the PDA, owned by SPL Token. The new
    // account is a PDA so it signs via invoke_signed with our seed list.
    let market_key = *market.key();
    let bump = [vault_bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(market_key.as_ref()),
        Seed::from(bump.as_ref()),
    ];
    let signer = Signer::from(seeds.as_ref());

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SPL_TOKEN_ACCOUNT_LEN as usize);
    system_create_account(
        authority,
        vault,
        lamports,
        SPL_TOKEN_ACCOUNT_LEN,
        &TOKEN_PROGRAM_ID,
        &[signer],
    )?;

    // Initialize the freshly-allocated account as a TokenAccount whose
    // authority is the vault PDA itself (it signs transfers out during
    // Withdraw via invoke_signed).
    token_initialize_account3(vault, quote_mint, vault.key())?;
    Ok(())
}

fn process_trade(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    size_q: u128,
    exec_price: u64,
    fee_bps: u64,
) -> ProgramResult {
    let [market, long_portfolio, short_portfolio, authority, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !long_portfolio.is_writable() || !short_portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { long_portfolio.owner() } != program_id
        || unsafe { short_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut long_data = long_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut short_data = short_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    // For MVP the same authority is the owner-of-record for both sides
    // (self-cross during testing). A real CLOB matches resting maker orders
    // against an incoming taker and verifies maker signatures via a separate
    // path (delegated authority or pre-signed orders) — out of scope here.
    {
        let (l_header, _) = portfolio_split_mut(&mut long_data)?;
        if l_header.owner != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
    }
    {
        let (s_header, _) = portfolio_split_mut(&mut short_data)?;
        if s_header.owner != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
    }

    trade_buffer(
        &mut market_data,
        &mut long_data,
        &mut short_data,
        asset_index,
        size_q,
        exec_price,
        fee_bps,
    )
    .map_v16()?;
    Ok(())
}

fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u128,
) -> ProgramResult {
    let [market, portfolio, owner, user_token, vault_token, _token_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !owner.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !portfolio.is_writable()
        || !user_token.is_writable()
        || !vault_token.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { portfolio.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Verify the vault account matches the one recorded in the wrapper, and
    // capture the oracle kind for the memecoin collateral cap below.
    let oracle_kind = {
        let market_data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&market_data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if *vault_token.key() != wrapper.vault {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        wrapper.oracle_kind
    };

    // SPL Token Transfer is u64; clamp the engine's u128 amount.
    let amount_u64: u64 = amount
        .try_into()
        .map_err(|_| OpenPerpsError::ArithmeticOverflow)?;
    if amount_u64 > 0 {
        token_transfer(user_token, vault_token, owner, amount_u64)?;
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut portfolio_data = portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    let (m_header, m_slots) = market_engine_split_mut(&mut market_data)?;
    let (p_header, p_domains) = portfolio_split_mut(&mut portfolio_data)?;

    if p_header.owner != *owner.key() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }

    {
        let mut mg = MarketGroupV16ViewMut::new(m_header, m_slots);
        let mut pv = PortfolioV16ViewMut::new(p_header, p_domains);
        mg.deposit_not_atomic(&mut pv, amount).map_v16()?;
    }

    // Memecoin collateral cap (anti-manipulation backstop): on a DEX-priced
    // market, no single account may hold more than MAX_CUSTOM_PORTFOLIO_CAPITAL
    // of collateral, which bounds the largest position (collateral × leverage)
    // and therefore the profit extractable by manipulating the thin pool. Majors
    // are exempt. The whole tx reverts (undoing the SPL transfer) if exceeded.
    if oracle_kind == crate::state::oracle_kind::DEX_EWMA {
        let (p_header2, _) = portfolio_split_mut(&mut portfolio_data)?;
        if p_header2.capital.get() > MAX_CUSTOM_PORTFOLIO_CAPITAL {
            return Err(OpenPerpsError::DepositCapExceeded.into());
        }
    }
    Ok(())
}

// ---------- House Vault handlers ----------

/// Derive + verify the House Vault PDA address from the wrapper-stored bump.
fn verify_house_pda(
    market_key: &Pubkey,
    house_portfolio: &AccountInfo,
    house_bump: u8,
    program_id: &Pubkey,
) -> Result<(), OpenPerpsError> {
    let derived = create_program_address(
        &[HOUSE_SEED, market_key.as_ref(), &[house_bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *house_portfolio.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData);
    }
    Ok(())
}

fn process_create_house_vault(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    house_bump: u8,
) -> ProgramResult {
    let [market, authority, house_portfolio, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !house_portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Wrapper validation: authority must match, house not yet created.
    let (asset_slot_capacity, market_group_id) = {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.authority != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
        if wrapper.house_bump != 0 {
            return Err(OpenPerpsError::AccountAlreadyInitialized.into());
        }
        let engine = market_header(&data)?;
        (
            engine.asset_slot_capacity.get() as usize,
            engine.market_group_id,
        )
    };

    let market_key = *market.key();
    verify_house_pda(&market_key, house_portfolio, house_bump, program_id)?;

    // Allocate the house portfolio account via invoke_signed.
    let portfolio_size = portfolio_account_size(asset_slot_capacity)?;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(portfolio_size);
    let bump_arr = [house_bump];
    let seeds = [
        Seed::from(HOUSE_SEED),
        Seed::from(market_key.as_ref()),
        Seed::from(bump_arr.as_ref()),
    ];
    let signer = Signer::from(seeds.as_ref());
    system_create_account(
        authority,
        house_portfolio,
        lamports,
        portfolio_size as u64,
        program_id,
        &[signer],
    )?;

    // Initialize portfolio with owner = HOUSE_PDA. The PDA itself acts as
    // the engine-level provenance owner; portfolio_account_id reuses the
    // PDA bytes so the house is deterministic from market alone.
    let house_pda_bytes = *house_portfolio.key();
    {
        let mut pf_data = house_portfolio
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        init_portfolio_buffer(
            &mut pf_data,
            market_group_id,
            house_pda_bytes,
            house_pda_bytes,
        )
        .map_v16()?;
    }

    // Persist house_bump in wrapper so subsequent handlers can derive
    // the PDA without trusting instruction data.
    {
        let mut data = market
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let (wrapper, _engine, _slots) = crate::state::market_split_mut(&mut data)?;
        wrapper.house_bump = house_bump;
    }

    Ok(())
}

fn process_fund_house_vault(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u128,
) -> ProgramResult {
    let [market, house_portfolio, authority, authority_token, vault_token, _token_program, ..] =
        accounts
    else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !house_portfolio.is_writable()
        || !authority_token.is_writable()
        || !vault_token.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { house_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let market_key = *market.key();
    {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.authority != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
        if wrapper.house_bump == 0 {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if *vault_token.key() != wrapper.vault {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        verify_house_pda(&market_key, house_portfolio, wrapper.house_bump, program_id)?;
    }

    let amount_u64: u64 = amount
        .try_into()
        .map_err(|_| OpenPerpsError::ArithmeticOverflow)?;
    if amount_u64 > 0 {
        token_transfer(authority_token, vault_token, authority, amount_u64)?;
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut house_data = house_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    deposit_buffer(&mut market_data, &mut house_data, amount).map_v16()?;
    Ok(())
}

fn process_withdraw_house_vault(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u128,
) -> ProgramResult {
    let [market, house_portfolio, authority, vault_token, authority_token, _token_program, ..] =
        accounts
    else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !house_portfolio.is_writable()
        || !authority_token.is_writable()
        || !vault_token.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { house_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let market_key = *market.key();
    let vault_bump = {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.authority != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
        if wrapper.house_bump == 0 {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if *vault_token.key() != wrapper.vault {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        verify_house_pda(&market_key, house_portfolio, wrapper.house_bump, program_id)?;
        wrapper.vault_bump
    };

    let amount_u64: u64 = amount
        .try_into()
        .map_err(|_| OpenPerpsError::ArithmeticOverflow)?;

    // Engine first — engine refuses if the house has open positions.
    {
        let mut market_data = market
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let mut house_data = house_portfolio
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        withdraw_buffer(&mut market_data, &mut house_data, amount).map_v16()?;
    }

    if amount_u64 > 0 {
        let bump = [vault_bump];
        let seeds = [
            Seed::from(VAULT_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(bump.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        token_transfer_signed(
            vault_token,
            authority_token,
            vault_token,
            amount_u64,
            &[signer],
        )?;
    }
    Ok(())
}

fn process_place_order(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    side: u8,
    asset_index: u32,
    size_q: u128,
    exec_price: u64,
    fee_bps: u64,
) -> ProgramResult {
    let [market, user_portfolio, house_portfolio, user, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !user.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !user_portfolio.is_writable()
        || !house_portfolio.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { user_portfolio.owner() } != program_id
        || unsafe { house_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let market_key = *market.key();
    {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() || wrapper.house_bump == 0 {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        verify_house_pda(&market_key, house_portfolio, wrapper.house_bump, program_id)?;
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut user_data = user_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut house_data = house_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    // Authorize the signer: either the portfolio owner, or a registered
    // trading delegate (session key). The delegate account (optional 5th
    // account) must be program-owned, bound to this portfolio, and name the
    // signer. Delegates can only trade — never withdraw.
    {
        let (u_h, _) = portfolio_split_mut(&mut user_data)?;
        let owner = u_h.owner;
        let user_key = *user.key();
        if user_key != owner {
            let delegate_acc = accounts
                .get(4)
                .ok_or(OpenPerpsError::MissingRequiredSignature)?;
            if unsafe { delegate_acc.owner() } != program_id {
                return Err(OpenPerpsError::MissingRequiredSignature.into());
            }
            let d_data = delegate_acc
                .try_borrow_data()
                .map_err(|_| OpenPerpsError::InvalidAccountData)?;
            let (d_portfolio, d_delegate) = delegate_of(&d_data)?;
            if d_portfolio != *user_portfolio.key() || d_delegate != user_key {
                return Err(OpenPerpsError::MissingRequiredSignature.into());
            }
        }
    }

    // side = 0 → user is long, house is short. side = 1 → swap.
    match side {
        0 => {
            trade_buffer(
                &mut market_data,
                &mut user_data,
                &mut house_data,
                asset_index,
                size_q,
                exec_price,
                fee_bps,
            )
            .map_v16()?;
        }
        1 => {
            trade_buffer(
                &mut market_data,
                &mut house_data,
                &mut user_data,
                asset_index,
                size_q,
                exec_price,
                fee_bps,
            )
            .map_v16()?;
        }
        _ => return Err(OpenPerpsError::InvalidInstructionData.into()),
    }
    Ok(())
}

/// Settle a flat user account's positive realized PnL into withdrawable
/// `capital`, debiting the verified House. Permissionless: it only moves the
/// user's own profit into the user's own portfolio (the House is the gated
/// counterparty PDA), so any signer may crank it — no owner signature needed.
fn process_settle_pnl(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [market, user_portfolio, house_portfolio, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable()
        || !user_portfolio.is_writable()
        || !house_portfolio.is_writable()
    {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { user_portfolio.owner() } != program_id
        || unsafe { house_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let market_key = *market.key();
    {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() || wrapper.house_bump == 0 {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        // Gate the House: it must be THIS market's House Vault PDA, else an
        // attacker could drain any program-owned portfolio's capital.
        verify_house_pda(&market_key, house_portfolio, wrapper.house_bump, program_id)?;
    }
    // The user portfolio must not be the House itself (no self-settle).
    if *user_portfolio.key() == *house_portfolio.key() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut user_data = user_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut house_data = house_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    settle_pnl_buffer(&mut market_data, &mut user_data, &mut house_data).map_v16()?;
    Ok(())
}

fn process_create_mock_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    reserve_base: u64,
    reserve_quote: u64,
) -> ProgramResult {
    // The client pre-creates the pool account via System CreateAccount (owner
    // = this program), same as the market account in InitMarket; we just
    // write the header.
    let [pool, authority, base_mint, quote_mint, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !pool.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { pool.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let mut data = pool
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    init_mock_pool_buffer(
        &mut data,
        *base_mint.key(),
        *quote_mint.key(),
        *authority.key(),
        reserve_base,
        reserve_quote,
    )?;
    Ok(())
}

fn process_mock_swap(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_in: u64,
    base_to_quote: u8,
) -> ProgramResult {
    let [pool, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !pool.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { pool.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let mut data = pool
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    mock_pool_swap_buffer(&mut data, amount_in, base_to_quote != 0)?;
    Ok(())
}

fn process_crank_oracle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
) -> ProgramResult {
    // Permissionless: the price comes from the pinned pool, not the signer,
    // so any signer may pull a fresh mark. No authority pin, no keeper.
    let [market, pool, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { pool.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let spot = {
        let m_data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&m_data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        // Per-slot pinned pool (the slot wrapper) must match the passed pool.
        if slot_oracle_pool(&m_data, asset_index)? != *pool.key() {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        let p_data = pool
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        mock_pool_spot_price(&p_data)?
    };

    let now_slot = Clock::get()?.slot;
    let mut m_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    crank_oracle_buffer(&mut m_data, asset_index, spot, now_slot).map_v16()?;
    Ok(())
}

fn process_pin_oracle_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
) -> ProgramResult {
    let [market, pool, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { pool.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    let pool_key = *pool.key();
    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    {
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
    }
    set_slot_oracle_pool(&mut data, asset_index, pool_key)?;
    Ok(())
}

fn process_set_delegate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    delegate: [u8; 32],
    bump: u8,
) -> ProgramResult {
    let [delegate_pda, portfolio, owner, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !owner.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !delegate_pda.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { portfolio.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Only the portfolio owner may authorize a delegate.
    let portfolio_key = *portfolio.key();
    {
        let pf_data = portfolio
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        if crate::state::portfolio_owner(&pf_data)? != *owner.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
    }

    // Verify the PDA address, then create it on first use.
    let derived = create_program_address(
        &[DELEGATE_SEED, portfolio_key.as_ref(), &[bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *delegate_pda.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    if unsafe { delegate_pda.owner() } != program_id {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(DelegateAccount::LEN);
        let bump_arr = [bump];
        let seeds = [
            Seed::from(DELEGATE_SEED),
            Seed::from(portfolio_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            owner,
            delegate_pda,
            lamports,
            DelegateAccount::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    let mut data = delegate_pda
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    set_delegate_buffer(&mut data, portfolio_key, delegate)?;
    Ok(())
}
