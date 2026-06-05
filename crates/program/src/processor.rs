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
        deposit_buffer, init_market_buffer, init_portfolio_buffer,
        liquidate_buffer, market_engine_split_mut, market_header, market_wrapper_header,
        delegate_of, deposit_cap_of, dex_pool_of, mock_pool_spot_price, oracle_authority_of,
        portfolio_account_size, portfolio_split_mut, resolve_market_buffer, set_delegate_buffer,
        set_deposit_cap_buffer, set_dex_pool_buffer, set_oracle_authority_buffer, set_slot_oracle_pool,
        settle_pnl_buffer, slot_oracle_pool, trade_buffer, withdraw_buffer, DelegateAccount,
        DELEGATE_SEED, DepositCapAccount, DEPOSIT_CAP_SEED, DexPoolConfig, DEXPOOL_SEED,
        OracleAuthorityAccount, ORACLE_SEED, HOUSE_SEED, PORTFOLIO_SEED, VAULT_SEED,
        twap_observe_buffer, TwapState, TWAP_SEED,
    },
};

// Buffer initializers used only by the devnet-only mock-pool handlers; gated so
// a mainnet build (no devnet feature) does not flag them as unused.
#[cfg(feature = "devnet")]
use crate::state::{init_mock_pool_buffer, mock_pool_swap_buffer};

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

/// Resolve the oracle authority for a market's price gate. If the optional
/// per-market oracle authority PDA (the account at `pda_index`) is present, owned
/// by this program, initialized, bound to this market, and non-zero, that key
/// governs; otherwise the global relayer constant does. A valid such account can
/// only exist at the canonical `[ORACLE_SEED, market]` PDA (SetOracleAuthority
/// creates it there under the market authority), so a discriminator + market
/// match is enough to trust it. Markets that never set one stay on the relayer.
/// `pda_index` is the slot the caller's account layout reserves for the optional
/// PDA (AccrueAsset = 2, CrankRefresh = 3), since their fixed accounts differ.
fn resolve_oracle_authority(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    market_key: &Pubkey,
    pda_index: usize,
) -> Pubkey {
    if let Some(acc) = accounts.get(pda_index) {
        if unsafe { acc.owner() } == program_id {
            if let Ok(data) = acc.try_borrow_data() {
                if let Ok((mkt, auth)) = oracle_authority_of(&data) {
                    if mkt == *market_key && auth != [0u8; 32] {
                        return auth;
                    }
                }
            }
        }
    }
    ORACLE_AUTHORITY
}

/// Shared oracle price gate for `AccrueAsset` and `CrankRefresh`. The requested
/// `price` / `funding_e9` are honored only for the market's oracle authority
/// (`is_oracle`); every other signer is forced to a delta-0 update, the asset's
/// current on-chain `effective_price` with zero funding, so a permissionless
/// crank can drive certification / funding progress WITHOUT moving the mark.
/// Reading the current price is lazy (skipped on the oracle path), so the oracle
/// path touches no extra state. Centralizing this keeps the two handlers' gates
/// from drifting (the CrankRefresh gate was missing entirely, finding M1).
fn gated_price_update(
    is_oracle: bool,
    price: u64,
    funding_e9: i128,
    market_data: &mut [u8],
    asset_index: u32,
) -> Result<(u64, i128), OpenPerpsError> {
    if is_oracle {
        return Ok((price, funding_e9));
    }
    let (_, markets) = market_engine_split_mut(market_data)?;
    let current = markets
        .get(asset_index as usize)
        .ok_or(OpenPerpsError::InvalidAccountData)?
        .engine
        .asset
        .effective_price
        .get();
    Ok((current, 0))
}

/// Resolve the per-portfolio collateral cap for a DEX-priced market. If the
/// optional deposit-cap PDA (account index 6) is present, program-owned, bound to
/// this market, and names a cap above the floor, it raises the cap; otherwise the
/// floor `MAX_CUSTOM_PORTFOLIO_CAPITAL` applies. The PDA can only raise the cap,
/// never lower it, so the floor cannot be bypassed by omitting the account.
fn resolve_deposit_cap(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    market_key: &Pubkey,
) -> u128 {
    if let Some(acc) = accounts.get(6) {
        if unsafe { acc.owner() } == program_id {
            if let Ok(data) = acc.try_borrow_data() {
                if let Ok((mkt, cap)) = deposit_cap_of(&data) {
                    if mkt == *market_key && cap > MAX_CUSTOM_PORTFOLIO_CAPITAL {
                        return cap;
                    }
                }
            }
        }
    }
    MAX_CUSTOM_PORTFOLIO_CAPITAL
}

/// Per-portfolio collateral ceiling (quote atoms, 6 decimals = $1,000) on a
/// DEX-priced (memecoin) market. Caps the largest position any one account can
/// hold (collateral × leverage), which bounds the profit an attacker can extract
/// by manipulating the underlying thin pool, the economic backstop behind the
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
        } => {
            // Devnet-only raw two-account cross (allows self-cross / wash trades).
            // The production path is PlaceOrder (user vs House); a mainnet build
            // compiles no handler here, so the program rejects raw Trade.
            #[cfg(feature = "devnet")]
            {
                process_trade(program_id, accounts, asset_index, size_q, exec_price, fee_bps)
            }
            #[cfg(not(feature = "devnet"))]
            {
                let _ = (asset_index, size_q, exec_price, fee_bps);
                Err(OpenPerpsError::InvalidInstruction.into())
            }
        }
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
        } => {
            // Devnet-only price toy. Excluded from a mainnet build so no one can
            // stand up a token-less, freely-movable pool as an oracle source.
            #[cfg(feature = "devnet")]
            {
                process_create_mock_pool(program_id, accounts, reserve_base, reserve_quote)
            }
            #[cfg(not(feature = "devnet"))]
            {
                let _ = (reserve_base, reserve_quote);
                Err(OpenPerpsError::InvalidInstruction.into())
            }
        }
        OpenPerpsInstruction::MockSwap {
            amount_in,
            base_to_quote,
        } => {
            // Devnet-only: moves pool reserves with no token CPI (zero-cost price
            // push). Excluded from a mainnet build.
            #[cfg(feature = "devnet")]
            {
                process_mock_swap(program_id, accounts, amount_in, base_to_quote)
            }
            #[cfg(not(feature = "devnet"))]
            {
                let _ = (amount_in, base_to_quote);
                Err(OpenPerpsError::InvalidInstruction.into())
            }
        }
        OpenPerpsInstruction::CrankOracle { asset_index } => {
            process_crank_oracle(program_id, accounts, asset_index)
        }
        OpenPerpsInstruction::PinOraclePool { asset_index } => {
            process_pin_oracle_pool(program_id, accounts, asset_index)
        }
        OpenPerpsInstruction::SetDelegate {
            delegate,
            bump,
            expiry_slot,
        } => process_set_delegate(program_id, accounts, delegate, bump, expiry_slot),
        OpenPerpsInstruction::SettlePnl => process_settle_pnl(program_id, accounts),
        OpenPerpsInstruction::SetOracleAuthority { authority, bump } => {
            process_set_oracle_authority(program_id, accounts, authority, bump)
        }
        OpenPerpsInstruction::SetDepositCap { max_capital, bump } => {
            process_set_deposit_cap(program_id, accounts, max_capital, bump)
        }
        OpenPerpsInstruction::CrankPyth { asset_index } => {
            process_crank_pyth(program_id, accounts, asset_index)
        }
        OpenPerpsInstruction::SetDexPool {
            base_vault,
            quote_vault,
            base_decimals,
            min_quote_depth,
            bump,
        } => process_set_dex_pool(
            program_id,
            accounts,
            base_vault,
            quote_vault,
            base_decimals,
            min_quote_depth,
            bump,
        ),
        OpenPerpsInstruction::CrankDexSpot { asset_index, bump } => {
            process_crank_dex_spot(program_id, accounts, asset_index, bump)
        }
        OpenPerpsInstruction::PlaceBatchOrder { count } => {
            process_place_batch_order(program_id, accounts, instruction_data, count)
        }
    }
}

fn process_init_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _requested_group_id: [u8; 32],
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
    // Fail fast if the collateral mint is not an SPL Token account. Not a drain
    // vector on its own (CreateVault's InitializeAccount3 rejects a non-mint),
    // but this stops the market header from ever recording a garbage quote_mint
    // that would disagree with the vault the later handlers enforce.
    if unsafe { quote_mint.owner() } != &TOKEN_PROGRAM_ID {
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

    // Bind the engine provenance domain to THIS market account: the market group
    // id is the market account address, not a client-chosen value. Provenance is
    // then one-to-one with the per-market vault [VAULT_SEED, market.key()], so a
    // portfolio funded against one market can never deposit to / withdraw from a
    // different market's vault by colliding on a shared group id. The requested
    // id from the instruction is ignored.
    let mut data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    init_market_buffer(
        &mut data,
        market_key,
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
    // griefing. (No authority pin, see PinOraclePool / permissionless launch.)
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
    // a market's mark. Any other signer is FORCED to a delta-0 accrual, we
    // ignore their requested price/funding and re-assert the current on-chain
    // effective_price. This keeps the permissionless stale-loss-lock clear the
    // trade flow prepends (it only needs to advance `slot_last`) working with no
    // race, while making it impossible for an attacker to walk the mark (clamped
    // or not) and drain the House. Forcing delta-0 (rather than rejecting a
    // mismatch) avoids a TOCTOU race where the relayer moves the price between
    // the client reading it and the tx landing. (Devnet/early-mainnet trust
    // model: a pinned relayer key; the trustless variant sources the price from
    // the on-chain DEX pool via CrankOracle.)
    let is_oracle =
        *authority.key() == resolve_oracle_authority(program_id, accounts, market.key(), 2);
    let (effective_price, funding_rate_e9) =
        gated_price_update(is_oracle, effective_price, funding_rate_e9, &mut data, asset_index)?;
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
    // Permissionless, any signer pays tx fee and drives progress.
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

    // ORACLE GATE (same as process_accrue_asset): a permissionless cranker may
    // drive certification + funding progress, but MUST NOT move the mark. Only
    // the market's oracle authority (the rotatable per-market PDA at account
    // index 3, else the relayer constant) may supply a fresh price; every other
    // signer is forced to a delta-0 refresh that re-asserts the current on-chain
    // effective_price. Without this gate CrankRefresh was a permissionless bypass
    // of the AccrueAsset price gate: any signer could walk the mark (bounded by
    // the engine's per-slot move clamp) or desync raw_oracle_target_price to
    // grief trading and assist unfair liquidations.
    let is_oracle =
        *cranker.key() == resolve_oracle_authority(program_id, accounts, market.key(), 3);
    let (effective_price, funding_rate_e9) = gated_price_update(
        is_oracle,
        effective_price,
        funding_rate_e9,
        &mut market_data,
        asset_index,
    )?;

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
    // any tokens, clean atomic semantics.
    {
        let mut market_data = market
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let mut portfolio_data = portfolio
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        // Owner check against the portfolio header.
        {
            let p_header = portfolio_split_mut(&mut portfolio_data)?;
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

#[cfg(feature = "devnet")]
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
    // path (delegated authority or pre-signed orders), out of scope here.
    {
        let l_header = portfolio_split_mut(&mut long_data)?;
        if l_header.owner != *authority.key() {
            return Err(OpenPerpsError::MissingRequiredSignature.into());
        }
    }
    {
        let s_header = portfolio_split_mut(&mut short_data)?;
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
    let p_header = portfolio_split_mut(&mut portfolio_data)?;

    if p_header.owner != *owner.key() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }

    {
        let mut mg = MarketGroupV16ViewMut::new(m_header, m_slots);
        let mut pv = PortfolioV16ViewMut::new(p_header);
        mg.deposit_not_atomic(&mut pv, amount).map_v16()?;
    }

    // Memecoin collateral cap (anti-manipulation backstop): on a DEX-priced
    // market, no single account may hold more than MAX_CUSTOM_PORTFOLIO_CAPITAL
    // of collateral, which bounds the largest position (collateral × leverage)
    // and therefore the profit extractable by manipulating the thin pool. Majors
    // are exempt. The whole tx reverts (undoing the SPL transfer) if exceeded.
    if oracle_kind == crate::state::oracle_kind::DEX_EWMA {
        let cap = resolve_deposit_cap(program_id, accounts, market.key());
        let p_header2 = portfolio_split_mut(&mut portfolio_data)?;
        if p_header2.capital.get() > cap {
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

    // Engine first, engine refuses if the house has open positions.
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
    // signer. Delegates can only trade, never withdraw.
    {
        let u_h = portfolio_split_mut(&mut user_data)?;
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
            let (d_portfolio, d_delegate, d_expiry) = delegate_of(&d_data)?;
            if d_portfolio != *user_portfolio.key() || d_delegate != user_key {
                return Err(OpenPerpsError::MissingRequiredSignature.into());
            }
            // Session keys are time-bounded: reject past the expiry slot so a
            // leaked delegate key cannot trade indefinitely.
            if Clock::get()?.slot > d_expiry {
                return Err(OpenPerpsError::DelegateExpired.into());
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

/// Apply a batch of trade legs (user vs House) in one tx, with a single margin
/// recertification (cheaper and atomic versus N separate `PlaceOrder`s). The user
/// is the long side: a leg with `side == 0` makes the user long that asset, `side
/// == 1` short. Each leg carries its own asset, size, price, and fee.
fn process_place_batch_order(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
    count: u8,
) -> ProgramResult {
    let [market, user_portfolio, house_portfolio, user, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !user.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !user_portfolio.is_writable() || !house_portfolio.is_writable() {
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

    // Authorize the signer: portfolio owner or a registered trading delegate
    // (session key), same as PlaceOrder. Delegates can only trade, never withdraw.
    {
        let u_h = portfolio_split_mut(&mut user_data)?;
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
            let (d_portfolio, d_delegate, d_expiry) = delegate_of(&d_data)?;
            if d_portfolio != *user_portfolio.key() || d_delegate != user_key {
                return Err(OpenPerpsError::MissingRequiredSignature.into());
            }
            // Session keys are time-bounded: reject past the expiry slot so a
            // leaked delegate key cannot trade indefinitely.
            if Clock::get()?.slot > d_expiry {
                return Err(OpenPerpsError::DelegateExpired.into());
            }
        }
    }

    // Decode the legs. The user is the engine's first (long) account, so a leg's
    // signed size is positive for `side == 0` (user long) and negative otherwise.
    let n = count as usize; // validated <= MAX_BATCH_LEGS by unpack
    let legs = instruction_data
        .get(2..)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut requests = [percolator::v16::TradeRequestV16 {
        asset_index: 0,
        size_q: 0,
        exec_price: 0,
        fee_bps: 0,
    }; crate::instruction::MAX_BATCH_LEGS];
    for (i, req) in requests.iter_mut().enumerate().take(n) {
        let o = i * crate::instruction::BATCH_LEG_BYTES;
        let leg = legs
            .get(o..o + crate::instruction::BATCH_LEG_BYTES)
            .ok_or(OpenPerpsError::InvalidInstructionData)?;
        let side = leg[0];
        let asset_index =
            u32::from_le_bytes(leg[1..5].try_into().unwrap()) as usize;
        let size = u128::from_le_bytes(leg[5..21].try_into().unwrap());
        let exec_price = u64::from_le_bytes(leg[21..29].try_into().unwrap());
        let fee_bps = u64::from_le_bytes(leg[29..37].try_into().unwrap());
        let signed = i128::try_from(size).map_err(|_| OpenPerpsError::ArithmeticOverflow)?;
        let size_q = match side {
            0 => signed,
            1 => signed
                .checked_neg()
                .ok_or(OpenPerpsError::ArithmeticOverflow)?,
            _ => return Err(OpenPerpsError::InvalidInstructionData.into()),
        };
        *req = percolator::v16::TradeRequestV16 {
            asset_index,
            size_q,
            exec_price,
            fee_bps,
        };
    }

    crate::state::batch_trade_buffer(
        &mut market_data,
        &mut user_data,
        &mut house_data,
        &requests[..n],
    )
    .map_v16()?;
    Ok(())
}

/// Settle a flat user account's positive realized PnL into withdrawable
/// `capital`, debiting the verified House. Permissionless: it only moves the
/// user's own profit into the user's own portfolio (the House is the gated
/// counterparty PDA), so any signer may crank it, no owner signature needed.
fn process_settle_pnl(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    // The new engine primitive converts the user's own released PnL to capital
    // and touches no other account, so the House is no longer passed in (the
    // old House-drain attack surface is gone with it).
    let [market, user_portfolio, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !user_portfolio.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id
        || unsafe { user_portfolio.owner() } != program_id
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    {
        let data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
    }

    let mut market_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let mut user_data = user_portfolio
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;

    settle_pnl_buffer(&mut market_data, &mut user_data).map_v16()?;
    Ok(())
}

#[cfg(feature = "devnet")]
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

#[cfg(feature = "devnet")]
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

/// Reject a Pyth price published more than this many seconds from the on-chain
/// clock (either stale or implausibly ahead).
const MAX_PYTH_AGE_SECS: i64 = 60;

/// Reject a Pyth price whose confidence interval exceeds this fraction of the
/// price (in bps): a too-uncertain price. 200 bps = 2%.
const MAX_PYTH_CONF_BPS: u64 = 200;

/// Reject a Pyth price whose spot diverges from the EMA by more than this
/// fraction (in bps): a single-tick spike or glitch. 1000 bps = 10%.
const MAX_PYTH_EMA_DIVERGENCE_BPS: u64 = 1_000;

/// Permissionless Pyth crank for a `PYTH` market: read a verified `PriceUpdateV2`
/// account (owned by the receiver program), bind it to the market's feed id,
/// check Full verification and freshness, convert the price to the mark scale,
/// and accrue the mark, bounded by the per-slot move clamp like the authority
/// relayer. The price comes from the verified account, not the signer, so any
/// signer may crank.
fn process_crank_pyth(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
) -> ProgramResult {
    let [market, price_update, signer, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !signer.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    // The price update must be owned by the Pyth receiver program (not us).
    if unsafe { price_update.owner() } != &crate::pyth::PYTH_RECEIVER {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    let clock = Clock::get()?;
    let now_slot = clock.slot;
    let now_unix = clock.unix_timestamp;

    let mark = {
        let m_data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&m_data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.oracle_kind != crate::state::oracle_kind::PYTH {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        let feed_id = wrapper.oracle_feed_id;
        let pu_data = price_update
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let pp = crate::pyth::parse_price_update_v2(&pu_data, &feed_id)
            .map_err(|_| OpenPerpsError::StalePythPrice)?;
        let age = now_unix.saturating_sub(pp.publish_time);
        if age > MAX_PYTH_AGE_SECS || age < -MAX_PYTH_AGE_SECS {
            return Err(OpenPerpsError::StalePythPrice.into());
        }
        // Reject a too-uncertain price (wide confidence band).
        if !crate::pyth::confidence_ok(pp.price, pp.conf, MAX_PYTH_CONF_BPS) {
            return Err(OpenPerpsError::StalePythPrice.into());
        }
        // Reject a spot that diverges too far from the smoothed EMA (a spike).
        if !crate::pyth::ema_divergence_ok(pp.price, pp.ema_price, MAX_PYTH_EMA_DIVERGENCE_BPS) {
            return Err(OpenPerpsError::StalePythPrice.into());
        }
        // PRICE_SCALE is 1e6, so the mark carries 6 quote decimals.
        crate::pyth::price_to_mark(pp.price, pp.expo, 6).map_err(|_| OpenPerpsError::StalePythPrice)?
    };

    let mut m_data = market
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    accrue_asset_buffer(&mut m_data, asset_index, now_slot, mark, 0, /* protective */ true)
        .map_v16()?;
    Ok(())
}

/// Bind a DEX-priced market's constant-product pool (its two SPL reserve vaults,
/// base decimals, and minimum depth). Only the market authority may call. The
/// `[DEXPOOL_SEED, market]` PDA is created on first use.
fn process_set_dex_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    base_vault: [u8; 32],
    quote_vault: [u8; 32],
    base_decimals: u8,
    min_quote_depth: u64,
    bump: u8,
) -> ProgramResult {
    let [config_pda, market, authority, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !config_pda.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
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
    }

    let derived =
        create_program_address(&[DEXPOOL_SEED, market_key.as_ref(), &[bump]], program_id)
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *config_pda.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    if unsafe { config_pda.owner() } != program_id {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(DexPoolConfig::LEN);
        let bump_arr = [bump];
        let seeds = [
            Seed::from(DEXPOOL_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            authority,
            config_pda,
            lamports,
            DexPoolConfig::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    let mut data = config_pda
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    set_dex_pool_buffer(
        &mut data,
        market_key,
        base_vault,
        quote_vault,
        base_decimals,
        min_quote_depth,
    )?;
    Ok(())
}

/// Permissionless DEX spot crank for a `DEX_EWMA` market: read the two pinned
/// reserve vaults, reject a pool whose quote depth is below the floor, derive the
/// spot, and fold it into the EWMA mark (per-slot move bound + freshness). The
/// price comes from the pinned vaults, not the signer, so any signer may crank.
fn process_crank_dex_spot(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    asset_index: u32,
    bump: u8,
) -> ProgramResult {
    let [market, config_pda, base_vault, quote_vault, twap_pda, cranker, _system_program, ..] =
        accounts
    else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !cranker.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !market.is_writable() || !twap_pda.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id || unsafe { config_pda.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }
    // The reserve vaults must be SPL token accounts.
    if unsafe { base_vault.owner() } != &TOKEN_PROGRAM_ID
        || unsafe { quote_vault.owner() } != &TOKEN_PROGRAM_ID
    {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Verify the TWAP-state PDA address [TWAP_SEED, market, asset_index].
    let market_key = *market.key();
    let aidx = asset_index.to_le_bytes();
    let derived = create_program_address(
        &[TWAP_SEED, market_key.as_ref(), aidx.as_ref(), &[bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *twap_pda.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    let spot = {
        let m_data = market
            .try_borrow_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        let wrapper = market_wrapper_header(&m_data)?;
        if !wrapper.is_initialized() {
            return Err(OpenPerpsError::UninitializedAccount.into());
        }
        if wrapper.oracle_kind != crate::state::oracle_kind::DEX_EWMA {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        let cfg = {
            let c_data = config_pda
                .try_borrow_data()
                .map_err(|_| OpenPerpsError::InvalidAccountData)?;
            dex_pool_of(&c_data, &market_key)?
        };
        // The passed vaults must be the ones the authority pinned.
        if *base_vault.key() != cfg.base_vault || *quote_vault.key() != cfg.quote_vault {
            return Err(OpenPerpsError::InvalidAccountData.into());
        }
        let reserve_base = {
            let d = base_vault
                .try_borrow_data()
                .map_err(|_| OpenPerpsError::InvalidAccountData)?;
            crate::dexamm::token_account_amount(&d)
                .map_err(|_| OpenPerpsError::InvalidAccountData)?
        };
        let reserve_quote = {
            let d = quote_vault
                .try_borrow_data()
                .map_err(|_| OpenPerpsError::InvalidAccountData)?;
            crate::dexamm::token_account_amount(&d)
                .map_err(|_| OpenPerpsError::InvalidAccountData)?
        };
        crate::dexamm::check_depth(reserve_quote, u64::from_le_bytes(cfg.min_quote_depth))
            .map_err(|_| OpenPerpsError::PoolTooThin)?;
        crate::dexamm::cp_spot_to_mark(reserve_base, reserve_quote, cfg.base_decimals as u32)
            .map_err(|_| OpenPerpsError::PoolTooThin)?
    };

    let clock = Clock::get()?;
    let now_slot = clock.slot;
    let now_ts = clock.unix_timestamp;

    // Lazily create the TWAP-state PDA on the first crank (the cranker pays the
    // small rent); later cranks reuse it.
    if unsafe { twap_pda.owner() } != program_id {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(TwapState::LEN);
        let bump_arr = [bump];
        let seeds = [
            Seed::from(TWAP_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(aidx.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            cranker,
            twap_pda,
            lamports,
            TwapState::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    // Fold the spot into the rolling TWAP. The mark is moved only when a full
    // window has elapsed (off the time-weighted average), so a single-block
    // reserve flash, held for ~0 seconds, cannot shift it.
    let twap = {
        let mut t_data = twap_pda
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        twap_observe_buffer(&mut t_data, market_key, asset_index, now_ts, spot)?
    };

    if let Some(price) = twap {
        let mut m_data = market
            .try_borrow_mut_data()
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
        crank_oracle_buffer(&mut m_data, asset_index, price, now_slot).map_v16()?;
    }
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
    expiry_slot: u64,
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
    set_delegate_buffer(&mut data, portfolio_key, delegate, expiry_slot)?;
    Ok(())
}

/// Set or rotate the market's oracle authority. Only the market authority (the
/// key in the wrapper header) may call. The per-market PDA at
/// `[ORACLE_SEED, market]` is created on first use; once set, its key is the
/// only one allowed to move the mark via `AccrueAsset` (a zero key revokes back
/// to the program constant). This removes the global single-key trust point for
/// markets that opt in, without changing the header layout or breaking markets
/// that stay on the relayer constant.
fn process_set_oracle_authority(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_authority: [u8; 32],
    bump: u8,
) -> ProgramResult {
    let [oracle_pda, market, authority, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !oracle_pda.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Only the market authority may set or rotate the oracle authority.
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
    }

    // Verify the PDA address, then create it on first use.
    let derived = create_program_address(
        &[ORACLE_SEED, market_key.as_ref(), &[bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *oracle_pda.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    if unsafe { oracle_pda.owner() } != program_id {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(OracleAuthorityAccount::LEN);
        let bump_arr = [bump];
        let seeds = [
            Seed::from(ORACLE_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            authority,
            oracle_pda,
            lamports,
            OracleAuthorityAccount::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    let mut data = oracle_pda
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    set_oracle_authority_buffer(&mut data, market_key, new_authority)?;
    Ok(())
}

/// Set the market's per-portfolio deposit cap for DEX-priced markets. Only the
/// market authority may call. The `[DEPOSIT_CAP_SEED, market]` PDA is created on
/// first use; its `max_capital` raises the per-portfolio collateral cap above the
/// program floor (it can never lower it; the floor is always enforced). Use this
/// to let a market with a deep pool support larger positions than the default.
fn process_set_deposit_cap(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    max_capital: u128,
    bump: u8,
) -> ProgramResult {
    let [cap_pda, market, authority, _system_program, ..] = accounts else {
        return Err(OpenPerpsError::InvalidInstruction.into());
    };
    if !authority.is_signer() {
        return Err(OpenPerpsError::MissingRequiredSignature.into());
    }
    if !cap_pda.is_writable() {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }
    if unsafe { market.owner() } != program_id {
        return Err(OpenPerpsError::InvalidAccountOwner.into());
    }

    // Only the market authority may set the deposit cap.
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
    }

    // Verify the PDA address, then create it on first use.
    let derived = create_program_address(
        &[DEPOSIT_CAP_SEED, market_key.as_ref(), &[bump]],
        program_id,
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if *cap_pda.key() != derived {
        return Err(OpenPerpsError::InvalidAccountData.into());
    }

    if unsafe { cap_pda.owner() } != program_id {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(DepositCapAccount::LEN);
        let bump_arr = [bump];
        let seeds = [
            Seed::from(DEPOSIT_CAP_SEED),
            Seed::from(market_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            authority,
            cap_pda,
            lamports,
            DepositCapAccount::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    let mut data = cap_pda
        .try_borrow_mut_data()
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    set_deposit_cap_buffer(&mut data, market_key, max_capital)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        activate_market_buffer, init_market_buffer, market_account_size, oracle_kind,
    };

    /// A 1-slot market with asset 0 active and its mark seeded to `price`.
    fn market_with_active_asset(price: u64) -> Vec<u8> {
        let mut buf = vec![0u8; market_account_size(1).unwrap()];
        init_market_buffer(
            &mut buf,
            [9u8; 32],           // market_group_id
            1,                   // asset_slot_capacity
            [1u8; 32],           // authority
            [2u8; 32],           // quote_mint
            [3u8; 32],           // vault
            255,                 // vault_bump
            [0u8; 32],           // base_mint
            oracle_kind::MANUAL, // oracle_kind
            [0u8; 32],           // oracle_feed_id
            [0u8; 32],           // oracle_pool
        )
        .unwrap();
        activate_market_buffer(&mut buf, 0, price, 1).unwrap();
        buf
    }

    #[test]
    fn oracle_price_passes_through_untouched() {
        // The oracle path returns the requested price + funding verbatim and
        // never reads market state, so an empty buffer is fine.
        let mut empty: [u8; 0] = [];
        assert_eq!(
            gated_price_update(true, 555_000_000, 42, &mut empty, 0).unwrap(),
            (555_000_000, 42),
        );
    }

    #[test]
    fn non_oracle_is_forced_to_delta_zero() {
        // M1 regression: a non-oracle crank's requested price AND funding are
        // dropped; the gate re-asserts the current on-chain mark with zero
        // funding, so a permissionless CrankRefresh / AccrueAsset cannot move the
        // mark or inject funding. This is the exact decision both handlers run.
        let mut buf = market_with_active_asset(100_000_000);
        assert_eq!(
            gated_price_update(false, 555_000_000, 42, &mut buf, 0).unwrap(),
            (100_000_000, 0),
        );
    }

    #[test]
    fn non_oracle_out_of_range_asset_errors() {
        let mut buf = market_with_active_asset(100_000_000);
        assert!(gated_price_update(false, 1, 0, &mut buf, 9).is_err());
    }
}
