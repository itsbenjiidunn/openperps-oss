//! Host integration test: full InitMarket -> InitPortfolio -> Deposit ->
//! Activate -> Accrue -> Trade flow exercised through the engine's
//! production zero-copy views.
//!
//! The tests call the same `state::*_buffer` helpers the on-chain handlers
//! use, then drive the engine directly, bypassing only Pinocchio's
//! `AccountInfo` borrowing and the Clock sysvar.
//!
//! Wrapper-header fields (authority, quote_mint, vault) are dummied out here
//! because the engine never reads them; their on-chain wiring is verified by
//! the SBF smoke script.

use openperps_program::state::{
    accrue_asset_buffer, activate_market_buffer, crank_oracle_buffer, crank_refresh_buffer,
    init_market_buffer, init_portfolio_buffer, liquidate_buffer, market_account_size,
    market_engine_split_mut, portfolio_account_size, portfolio_split_mut, resolve_market_buffer,
    trade_buffer, withdraw_buffer,
};
use percolator::v16::{AssetLifecycleV16, MarketGroupV16ViewMut, PortfolioV16ViewMut, SideV16};

const CAP: u32 = 2;

// Dummy wrapper-header values the engine doesn't read. The on-chain handler
// fills these with the real authority pubkey, the SPL mint of the chosen
// collateral, the program-derived vault pubkey, and its bump.
const DUMMY_AUTHORITY: [u8; 32] = [0xAA; 32];
const DUMMY_QUOTE_MINT: [u8; 32] = [0xBB; 32];
const DUMMY_VAULT: [u8; 32] = [0xCC; 32];
const DUMMY_VAULT_BUMP: u8 = 254;
const DUMMY_BASE_MINT: [u8; 32] = [0xDD; 32];
const DUMMY_ORACLE_KIND: u8 = 1; // Pyth
const DUMMY_ORACLE_FEED_ID: [u8; 32] = [0xEE; 32];
const DUMMY_ORACLE_POOL: [u8; 32] = [0xF0; 32];

fn fresh_buffers() -> (Vec<u8>, Vec<u8>) {
    let m = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let p = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    (m, p)
}

/// Initialize a market buffer with dummy wrapper-header values.
fn setup_market(buf: &mut [u8], market_group_id: [u8; 32]) {
    init_market_buffer(
        buf,
        market_group_id,
        CAP,
        DUMMY_AUTHORITY,
        DUMMY_QUOTE_MINT,
        DUMMY_VAULT,
        DUMMY_VAULT_BUMP,
        DUMMY_BASE_MINT,
        DUMMY_ORACLE_KIND,
        DUMMY_ORACLE_FEED_ID,
        DUMMY_ORACLE_POOL,
    )
    .unwrap();
}

/// Same as `setup_market` but returns the result so a test can assert on it
/// (used for the double-init reject case).
fn try_setup_market(buf: &mut [u8], market_group_id: [u8; 32]) -> Result<(), ()> {
    init_market_buffer(
        buf,
        market_group_id,
        CAP,
        DUMMY_AUTHORITY,
        DUMMY_QUOTE_MINT,
        DUMMY_VAULT,
        DUMMY_VAULT_BUMP,
        DUMMY_BASE_MINT,
        DUMMY_ORACLE_KIND,
        DUMMY_ORACLE_FEED_ID,
        DUMMY_ORACLE_POOL,
    )
    .map_err(|_| ())
}

fn deposit(market_buf: &mut [u8], portfolio_buf: &mut [u8], amount: u128) {
    let (m_header, m_slots) = market_engine_split_mut(market_buf).unwrap();
    let p_header = portfolio_split_mut(portfolio_buf).unwrap();
    let mut mg = MarketGroupV16ViewMut::new(m_header, m_slots);
    let mut pv = PortfolioV16ViewMut::new(p_header);
    mg.deposit_not_atomic(&mut pv, amount).unwrap();
}

#[test]
fn init_then_deposit_credits_capital_and_vault() {
    let market_group_id = [0xAB; 32];
    let portfolio_account_id = [0xCD; 32];
    let owner = [0xEF; 32];
    let amount: u128 = 1_500_000;

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut pf_buf, market_group_id, portfolio_account_id, owner).unwrap();
    deposit(&mut market_buf, &mut pf_buf, amount);

    let (m_header, _) = market_engine_split_mut(&mut market_buf).unwrap();
    let p_header = portfolio_split_mut(&mut pf_buf).unwrap();
    assert_eq!(p_header.capital.get(), amount);
    assert_eq!(m_header.vault.get(), amount);
    assert_eq!(m_header.c_tot.get(), amount);
    assert_eq!(p_header.health_cert.valid, 0);
}

#[test]
fn deposits_accumulate() {
    let market_group_id = [1u8; 32];
    let portfolio_account_id = [2u8; 32];
    let owner = [3u8; 32];
    let chunk: u128 = 250_000;

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut pf_buf, market_group_id, portfolio_account_id, owner).unwrap();

    for _ in 0..3 {
        deposit(&mut market_buf, &mut pf_buf, chunk);
    }

    let (m_header, _) = market_engine_split_mut(&mut market_buf).unwrap();
    let p_header = portfolio_split_mut(&mut pf_buf).unwrap();
    assert_eq!(p_header.capital.get(), chunk * 3);
    assert_eq!(m_header.vault.get(), chunk * 3);
}

#[test]
fn zero_amount_deposit_is_a_noop() {
    let market_group_id = [9u8; 32];
    let portfolio_account_id = [8u8; 32];
    let owner = [7u8; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut pf_buf, market_group_id, portfolio_account_id, owner).unwrap();
    deposit(&mut market_buf, &mut pf_buf, 0);

    let (m_header, _) = market_engine_split_mut(&mut market_buf).unwrap();
    let p_header = portfolio_split_mut(&mut pf_buf).unwrap();
    assert_eq!(p_header.capital.get(), 0);
    assert_eq!(m_header.vault.get(), 0);
}

#[test]
fn init_market_rejects_double_init() {
    let mid = [4u8; 32];
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, mid);
    assert!(try_setup_market(&mut buf, mid).is_err());
}

#[test]
fn activate_market_transitions_slot_to_active() {
    let market_group_id = [0x11; 32];
    let portfolio_account_id = [0x22; 32];
    let owner = [0x33; 32];
    let price: u64 = 100_000_000;

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut pf_buf, market_group_id, portfolio_account_id, owner).unwrap();

    activate_market_buffer(&mut market_buf, 0, price, 1).unwrap();

    let (header, markets) = market_engine_split_mut(&mut market_buf).unwrap();
    let asset = markets[0].engine.asset.try_to_runtime().unwrap();
    assert_eq!(asset.lifecycle, AssetLifecycleV16::Active);
    assert_eq!(asset.market_id, 1);
    assert_eq!(asset.effective_price, price);
    assert_eq!(asset.raw_oracle_target_price, price);
    assert_eq!(asset.fund_px_last, price);
    assert_eq!(header.next_market_id.get(), 2);
    assert_eq!(header.asset_activation_count.get(), 1);
    assert_eq!(header.last_asset_activation_slot.get(), 1);

    deposit(&mut market_buf, &mut pf_buf, 1_000_000);
    let (h, _) = market_engine_split_mut(&mut market_buf).unwrap();
    assert_eq!(h.vault.get(), 1_000_000);
}

#[test]
fn activate_market_rejects_bad_inputs() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [1u8; 32]);
    assert!(activate_market_buffer(&mut buf, 0, 0, 1).is_err());
    assert!(activate_market_buffer(&mut buf, CAP, 100, 1).is_err());
}

#[test]
fn accrue_refreshes_price_and_advances_slot() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [7u8; 32]);
    activate_market_buffer(&mut buf, 0, 100, 1).unwrap();
    accrue_asset_buffer(&mut buf, 0, 5, 110, 0, false).unwrap();

    let (_h, m) = market_engine_split_mut(&mut buf).unwrap();
    let asset = m[0].engine.asset.try_to_runtime().unwrap();
    assert_eq!(asset.effective_price, 110);
    assert_eq!(asset.fund_px_last, 110);
    assert_eq!(asset.slot_last, 5);
    assert_eq!(asset.lifecycle, AssetLifecycleV16::Active);
}

#[test]
fn accrue_rejects_price_zero_and_too_high() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [8u8; 32]);
    activate_market_buffer(&mut buf, 0, 100, 1).unwrap();
    assert!(accrue_asset_buffer(&mut buf, 0, 2, 0, 0, false).is_err());
    assert!(accrue_asset_buffer(&mut buf, 0, 2, 1_000_000_000_001, 0, false).is_err());
}

#[test]
fn accrue_rejects_inactive_slot() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [10u8; 32]);
    assert!(accrue_asset_buffer(&mut buf, 0, 1, 100, 0, false).is_err());
}

#[test]
fn accrue_funding_rate_bounded_by_config() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [11u8; 32]);
    activate_market_buffer(&mut buf, 0, 100, 1).unwrap();
    // The per-slot funding cap is `max_abs_funding_e9_per_slot` (= 10 in
    // default_market_config); anything above it is rejected before accrual.
    assert!(accrue_asset_buffer(&mut buf, 0, 2, 100, 11, false).is_err());
    assert!(accrue_asset_buffer(&mut buf, 0, 2, 100, -11, false).is_err());
    accrue_asset_buffer(&mut buf, 0, 2, 100, 5, false).unwrap();
}

#[test]
fn trade_opens_matched_long_and_short_legs() {
    let market_group_id = [0x55; 32];
    let long_pf_id = [0xA1; 32];
    let short_pf_id = [0xA2; 32];
    let owner = [0xB0; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, market_group_id);
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();

    init_portfolio_buffer(&mut long_buf, market_group_id, long_pf_id, owner).unwrap();
    init_portfolio_buffer(&mut short_buf, market_group_id, short_pf_id, owner).unwrap();

    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);

    let outcome = trade_buffer(
        &mut market_buf,
        &mut long_buf,
        &mut short_buf,
        0,
        1_000_000,
        100_000_000,
        10,
    )
    .unwrap();

    assert_eq!(outcome.notional, 100_000_000);
    assert_eq!(outcome.fee_a, 100_000);
    assert_eq!(outcome.fee_b, 100_000);

    let (_, m_slots) = market_engine_split_mut(&mut market_buf).unwrap();
    let oi_long = m_slots[0].engine.asset.try_to_runtime().unwrap().oi_eff_long_q;
    let oi_short = m_slots[0].engine.asset.try_to_runtime().unwrap().oi_eff_short_q;
    assert_eq!(oi_long, 1_000_000);
    assert_eq!(oi_short, 1_000_000);

    let l_header = portfolio_split_mut(&mut long_buf).unwrap();
    let long_leg = l_header.legs[0].try_to_runtime().unwrap();
    assert!(long_leg.active);
    assert_eq!(long_leg.asset_index, 0);
    assert_eq!(long_leg.side, SideV16::Long);
    assert_eq!(long_leg.basis_pos_q, 1_000_000);

    let s_header = portfolio_split_mut(&mut short_buf).unwrap();
    let short_leg = s_header.legs[0].try_to_runtime().unwrap();
    assert!(short_leg.active);
    assert_eq!(short_leg.asset_index, 0);
    assert_eq!(short_leg.side, SideV16::Short);
    assert_eq!(short_leg.basis_pos_q, -1_000_000);
}

#[test]
fn crank_oracle_accrues_funding_on_matched_position() {
    // Open a matched long/short (balanced exposure), then crank the oracle
    // with a pool spot below the mark → the EWMA mark sits above the index, so
    // funding accrues (longs pay). Verifies the protective-progress path lets
    // the crank succeed with open positions and that funding actually moves.
    let mgid = [0x77; 32];
    let mut m = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut l = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut s = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut m, mgid);
    activate_market_buffer(&mut m, 0, 100_000_000, 1).unwrap();
    init_portfolio_buffer(&mut l, mgid, [1; 32], [9; 32]).unwrap();
    init_portfolio_buffer(&mut s, mgid, [2; 32], [9; 32]).unwrap();
    deposit(&mut m, &mut l, 50_000_000);
    deposit(&mut m, &mut s, 50_000_000);
    trade_buffer(&mut m, &mut l, &mut s, 0, 1_000_000, 100_000_000, 10).unwrap();

    // funding is zero before the crank
    let f_before = {
        let (_, slots) = market_engine_split_mut(&mut m).unwrap();
        slots[0].engine.asset.try_to_runtime().unwrap().f_long_num
    };

    // pool spot below the mark → EWMA stays above spot → positive funding.
    // The EWMA folds 90M into the 100M mark for a ~2% (2M) move; under the
    // 10 bps/slot price-move cap that needs at least ~20 slots of budget, so we
    // crank at slot 30 (dt = 29) rather than crowding it into a few slots.
    crank_oracle_buffer(&mut m, 0, 90_000_000, 30).unwrap();

    let (_, slots) = market_engine_split_mut(&mut m).unwrap();
    let asset = slots[0].engine.asset.try_to_runtime().unwrap();
    assert!(asset.effective_price < 100_000_000); // EWMA moved toward spot
    assert_ne!(asset.f_long_num, f_before); // funding accrued
}

#[test]
fn trade_works_when_pfs_inited_before_activate_no_accrue() {
    let mid = [0x21; 32];
    let owner = [0x22; 32];
    let mut m = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut l = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut s = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    setup_market(&mut m, mid);
    init_portfolio_buffer(&mut l, mid, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut s, mid, [2; 32], owner).unwrap();
    activate_market_buffer(&mut m, 0, 100_000_000, 1).unwrap();
    deposit(&mut m, &mut l, 50_000_000);
    deposit(&mut m, &mut s, 50_000_000);
    trade_buffer(&mut m, &mut l, &mut s, 0, 1_000_000, 100_000_000, 10).unwrap();
}

#[test]
fn trade_works_with_accrue_when_pfs_inited_after_activate() {
    let mid = [0x31; 32];
    let owner = [0x32; 32];
    let mut m = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut l = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut s = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    setup_market(&mut m, mid);
    activate_market_buffer(&mut m, 0, 100_000_000, 1).unwrap();
    accrue_asset_buffer(&mut m, 0, 2, 105_000_000, 0, false).unwrap();
    init_portfolio_buffer(&mut l, mid, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut s, mid, [2; 32], owner).unwrap();
    deposit(&mut m, &mut l, 50_000_000);
    deposit(&mut m, &mut s, 50_000_000);
    trade_buffer(&mut m, &mut l, &mut s, 0, 1_000_000, 105_000_000, 10).unwrap();
}

#[test]
fn trade_works_with_smoke_order_init_pfs_then_activate_then_accrue() {
    let market_group_id = [0xEE; 32];
    let owner = [0xFF; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut long_buf, market_group_id, [0xA1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, market_group_id, [0xA2; 32], owner).unwrap();
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();
    accrue_asset_buffer(&mut market_buf, 0, 2, 105_000_000, 0, false).unwrap();
    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);

    trade_buffer(
        &mut market_buf,
        &mut long_buf,
        &mut short_buf,
        0,
        1_000_000,
        105_000_000,
        10,
    )
    .unwrap();
}

#[test]
fn trade_rejects_when_asset_is_disabled() {
    let market_group_id = [0x66; 32];
    let owner = [0xC0; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, market_group_id);
    init_portfolio_buffer(&mut long_buf, market_group_id, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, market_group_id, [2; 32], owner).unwrap();
    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);

    assert!(trade_buffer(
        &mut market_buf,
        &mut long_buf,
        &mut short_buf,
        0,
        1_000_000,
        100_000_000,
        10,
    )
    .is_err());
}

#[test]
fn trade_rejects_oversize_when_capital_insufficient() {
    let market_group_id = [0x77; 32];
    let owner = [0xD0; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, market_group_id);
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();
    init_portfolio_buffer(&mut long_buf, market_group_id, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, market_group_id, [2; 32], owner).unwrap();
    deposit(&mut market_buf, &mut long_buf, 1_000);
    deposit(&mut market_buf, &mut short_buf, 1_000);

    assert!(trade_buffer(
        &mut market_buf,
        &mut long_buf,
        &mut short_buf,
        0,
        1_000_000,
        100_000_000,
        10,
    )
    .is_err());
}

#[test]
fn activate_market_cooldown_blocks_back_to_back() {
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [9u8; 32]);
    activate_market_buffer(&mut buf, 0, 100, 5).unwrap();
    assert!(activate_market_buffer(&mut buf, 1, 100, 5).is_err());
    activate_market_buffer(&mut buf, 1, 100, 6).unwrap();
}

#[test]
fn withdraw_reduces_capital_vault_and_c_tot() {
    let mid = [0x44; 32];
    let pf_id = [0x55; 32];
    let owner = [0x66; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, mid);
    init_portfolio_buffer(&mut pf_buf, mid, pf_id, owner).unwrap();
    deposit(&mut market_buf, &mut pf_buf, 1_000_000);
    withdraw_buffer(&mut market_buf, &mut pf_buf, 300_000).unwrap();

    let (m_header, _) = market_engine_split_mut(&mut market_buf).unwrap();
    let p_header = portfolio_split_mut(&mut pf_buf).unwrap();
    assert_eq!(p_header.capital.get(), 700_000);
    assert_eq!(m_header.vault.get(), 700_000);
    assert_eq!(m_header.c_tot.get(), 700_000);
}

#[test]
fn withdraw_zero_is_a_noop() {
    let mid = [0x47; 32];
    let pf_id = [0x48; 32];
    let owner = [0x49; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, mid);
    init_portfolio_buffer(&mut pf_buf, mid, pf_id, owner).unwrap();
    deposit(&mut market_buf, &mut pf_buf, 1_000_000);
    withdraw_buffer(&mut market_buf, &mut pf_buf, 0).unwrap();

    let (m_header, _) = market_engine_split_mut(&mut market_buf).unwrap();
    let p_header = portfolio_split_mut(&mut pf_buf).unwrap();
    assert_eq!(p_header.capital.get(), 1_000_000);
    assert_eq!(m_header.vault.get(), 1_000_000);
}

#[test]
fn withdraw_exceeding_capital_rejects() {
    let mid = [0x4A; 32];
    let pf_id = [0x4B; 32];
    let owner = [0x4C; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, mid);
    init_portfolio_buffer(&mut pf_buf, mid, pf_id, owner).unwrap();
    deposit(&mut market_buf, &mut pf_buf, 1_000_000);
    assert!(withdraw_buffer(&mut market_buf, &mut pf_buf, 1_000_001).is_err());
}

#[test]
fn withdraw_rejects_when_portfolio_has_active_leg() {
    // Open a position then try to withdraw, engine refuses because
    // `active_bitmap` is non-empty.
    let mid = [0x4D; 32];
    let owner = [0x4E; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, mid);
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();
    init_portfolio_buffer(&mut long_buf, mid, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, mid, [2; 32], owner).unwrap();
    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);
    trade_buffer(&mut market_buf, &mut long_buf, &mut short_buf, 0, 1_000_000, 100_000_000, 10)
        .unwrap();

    // Both portfolios now hold a leg → withdraw must reject.
    assert!(withdraw_buffer(&mut market_buf, &mut long_buf, 1).is_err());
    assert!(withdraw_buffer(&mut market_buf, &mut short_buf, 1).is_err());
}

#[test]
fn liquidate_refuses_healthy_account() {
    // Standard happy-path setup: 50M deposit on both sides, small 1M
    // position, price unchanged. Account is healthy → engine refuses with
    // NonProgress (the V16 way of saying "nothing to liquidate").
    let mid = [0x71; 32];
    let owner = [0x72; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, mid);
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();
    init_portfolio_buffer(&mut long_buf, mid, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, mid, [2; 32], owner).unwrap();
    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);
    trade_buffer(&mut market_buf, &mut long_buf, &mut short_buf, 0, 1_000_000, 100_000_000, 10)
        .unwrap();

    let err = liquidate_buffer(&mut market_buf, &mut long_buf, 0, 1_000_000, 10).unwrap_err();
    assert_eq!(err, percolator::v16::V16Error::NonProgress);
}

#[test]
fn liquidate_rejects_when_asset_index_out_of_range() {
    let mid = [0x73; 32];
    let pf_id = [0x74; 32];
    let owner = [0x75; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, mid);
    init_portfolio_buffer(&mut pf_buf, mid, pf_id, owner).unwrap();
    // No need to deposit or trade, the engine's first check is config.
    assert!(liquidate_buffer(&mut market_buf, &mut pf_buf, CAP, 1_000_000, 10).is_err());
}

#[test]
fn liquidate_rejects_zero_close_q() {
    let mid = [0x76; 32];
    let pf_id = [0x77; 32];
    let owner = [0x78; 32];

    let (mut market_buf, mut pf_buf) = fresh_buffers();
    setup_market(&mut market_buf, mid);
    init_portfolio_buffer(&mut pf_buf, mid, pf_id, owner).unwrap();
    assert!(liquidate_buffer(&mut market_buf, &mut pf_buf, 0, 0, 10).is_err());
}

#[test]
fn resolve_market_flips_mode_and_records_slot() {
    let mid = [0x81; 32];
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, mid);
    activate_market_buffer(&mut buf, 0, 100_000_000, 1).unwrap();

    resolve_market_buffer(&mut buf, /*resolved_slot=*/ 10).unwrap();

    let (header, _) = market_engine_split_mut(&mut buf).unwrap();
    // MarketModeV16::Resolved encodes as 1; current_slot bumped.
    assert_eq!(header.mode, 1);
    assert_eq!(header.resolved_slot.get(), 10);
    assert_eq!(header.current_slot.get(), 10);
}

#[test]
fn resolve_rejects_when_slot_goes_backwards() {
    let mid = [0x82; 32];
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, mid);
    activate_market_buffer(&mut buf, 0, 100_000_000, 5).unwrap();
    // current_slot is now 5; resolved_slot < current_slot must reject.
    assert!(resolve_market_buffer(&mut buf, 4).is_err());
}

#[test]
fn crank_refresh_certifies_a_healthy_active_account() {
    // After deposit + trade, cert.valid = 0. A Refresh crank re-certifies
    // the account so subsequent favorable actions can proceed.
    let mid = [0x83; 32];
    let owner = [0x84; 32];

    let mut market_buf = vec![0u8; market_account_size(CAP as usize).unwrap()];
    let mut long_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];
    let mut short_buf = vec![0u8; portfolio_account_size(CAP as usize).unwrap()];

    setup_market(&mut market_buf, mid);
    activate_market_buffer(&mut market_buf, 0, 100_000_000, 1).unwrap();
    init_portfolio_buffer(&mut long_buf, mid, [1; 32], owner).unwrap();
    init_portfolio_buffer(&mut short_buf, mid, [2; 32], owner).unwrap();
    deposit(&mut market_buf, &mut long_buf, 50_000_000);
    deposit(&mut market_buf, &mut short_buf, 50_000_000);
    trade_buffer(&mut market_buf, &mut long_buf, &mut short_buf, 0, 1_000_000, 100_000_000, 10)
        .unwrap();

    crank_refresh_buffer(&mut market_buf, &mut long_buf, /*now=*/ 2, 0, 100_000_000, 0)
        .unwrap();

    let p_header = portfolio_split_mut(&mut long_buf).unwrap();
    assert_eq!(p_header.health_cert.valid, 1);
}

#[test]
fn market_wrapper_header_stores_authority_mint_vault() {
    use openperps_program::state::market_wrapper_header;
    let (mut buf, _) = fresh_buffers();
    setup_market(&mut buf, [0x12; 32]);
    let wrapper = market_wrapper_header(&buf).unwrap();
    assert!(wrapper.is_initialized());
    assert_eq!(wrapper.version, 4);
    assert_eq!(wrapper.authority, DUMMY_AUTHORITY);
    assert_eq!(wrapper.quote_mint, DUMMY_QUOTE_MINT);
    assert_eq!(wrapper.vault, DUMMY_VAULT);
    assert_eq!(wrapper.vault_bump, DUMMY_VAULT_BUMP);
    // house_bump = 0 until CreateHouseVault is called.
    assert_eq!(wrapper.house_bump, 0);
    // v3 self-describing fields.
    assert_eq!(wrapper.base_mint, DUMMY_BASE_MINT);
    assert_eq!(wrapper.oracle_kind, DUMMY_ORACLE_KIND);
    assert_eq!(wrapper.oracle_feed_id, DUMMY_ORACLE_FEED_ID);
    // v4 DEX pool binding.
    assert_eq!(wrapper.oracle_pool, DUMMY_ORACLE_POOL);
}
