//! On-chain account layouts, zero-copy split helpers, and buffer-level
//! initializers shared between the program handlers and host tests.
//!
//! The engine ships POD `*Account` types that map directly onto account data.
//! All `V16Pod*` integer wrappers are `[u8; N]` (alignment 1), so the byte
//! slice underlying an `AccountInfo`'s data can be split into
//! `(&mut Header, &mut [Slot])` without any alignment dance.

use bytemuck::{Pod, Zeroable};
use percolator::v16::{
    LiquidationOutcomeV16, LiquidationRequestV16, Market, MarketGroupV16HeaderAccount,
    MarketGroupV16ViewMut, PermissionlessCrankActionV16, PermissionlessCrankRequestV16,
    PortfolioAccountV16Account, PortfolioLegV16, PortfolioLegV16Account,
    PortfolioSourceDomainV16Account, PortfolioV16ViewMut, ProvenanceHeaderV16,
    ProvenanceHeaderV16Account, TradeOutcomeV16, TradeRequestV16, V16ConfigAccount, V16Error,
    V16PodU128, V16PodU16, V16PodU32, V16PodU64, V16_MAX_PORTFOLIO_ASSETS_N,
};

use crate::error::OpenPerpsError;

/// Per-slot wrapper payload embedded at the start of each engine market slot
/// (`Market<T>` stores `wrapper: T` first). We use it to pin a per-asset DEX
/// **oracle pool** so a single shared market group can price many assets
/// independently (cross-margin: one portfolio, many slots). All-zero until
/// `PinOraclePool` writes the slot's pool. 32 bytes, alignment 1.
pub type MarketWrapper = [u8; 32];

/// One market slot inside a market-group account.
pub type MarketSlot = Market<MarketWrapper>;

/// Engine's `encode_bool` is private; mirror it (true → 1).
const TRUE: u8 = 1;

// ---------- OpenPerps wrapper header ----------

/// Magic bytes at the start of a market account — distinguishes an OpenPerps
/// market group from any other account that happens to live under this
/// program, and from uninitialized (all-zero) data.
pub const MARKET_DISCRIMINATOR: [u8; 8] = *b"OPMARKET";

/// Layout version of [`OpenPerpsMarketHeader`]. Bump if this struct's bytes
/// ever change in a backward-incompatible way. v2 reorganizes the padding
/// after `vault_bump` to add `house_bump` without changing the header's
/// total byte size (one of the three padding bytes becomes `house_bump`).
/// v3 makes the market self-describing on-chain: it appends `base_mint`
/// (the underlying asset's SPL mint, or zeros for a synthetic like BTC/ETH)
/// and the oracle binding (`oracle_kind` + `oracle_feed_id`), and steals
/// one of the two remaining pad bytes for `oracle_kind`. Header grows from
/// 112 → 176 bytes. v4 appends `oracle_pool` (32) — the on-chain DEX pool
/// account whose EWMA prices the market (DEX-EWMA oracle). 176 → 208 bytes.
pub const MARKET_HEADER_VERSION: u32 = 4;

/// `oracle_kind` discriminants stored in [`OpenPerpsMarketHeader`].
pub mod oracle_kind {
    /// Authority-set / devnet-simulated price (no external oracle yet).
    pub const MANUAL: u8 = 0;
    /// A Pyth pull-oracle feed id is bound; on-chain CPI lands in a later
    /// phase. Until then the price is still authority-seeded.
    pub const PYTH: u8 = 1;
    /// Price is derived from an on-chain DEX pool's reserves, smoothed by an
    /// on-chain EWMA. `oracle_pool` names the pool account; any
    /// signer can `CrankOracle` to pull a fresh price — no trusted keeper.
    pub const DEX_EWMA: u8 = 2;
}

/// EWMA smoothing factor in bps (α = 0.2). `new = old + α·(spot − old)`.
/// Small enough to resist single-swap manipulation, large enough that the
/// mark visibly tracks the pool over a handful of cranks.
pub const ORACLE_EWMA_ALPHA_BPS: u64 = 2_000;

/// Funding rate (e9 per slot) the oracle crank applies in the direction of the
/// mark-vs-index premium. Must stay ≤ `max_abs_funding_e9_per_slot` in
/// [`default_market_config`], or the engine rejects the accrual.
pub const ORACLE_FUNDING_MAX_E9: i128 = 10;

/// Fixed-point scale for prices: quote atoms per 1.0 base, 6 decimals —
/// matches the shared mock-USDC mint.
pub const PRICE_SCALE: u128 = 1_000_000;

/// Magic bytes at the start of a [`MockPoolHeader`] account.
pub const MOCK_POOL_DISCRIMINATOR: [u8; 8] = *b"OPMKPOOL";

/// PDA seed prefix for the per-market vault. The full seed list is
/// `[VAULT_SEED, market.key()]`.
pub const VAULT_SEED: &[u8] = b"vault";

/// PDA seed prefix for the per-market House Vault portfolio's *owner*.
/// The full seed list is `[HOUSE_SEED, market.key()]`. The portfolio
/// account address itself is also a PDA derived from the same seeds so
/// the client can find the house deterministically.
pub const HOUSE_SEED: &[u8] = b"house";

/// PDA seed prefix for a portfolio's trading delegate (session key). Full
/// seeds: `[DELEGATE_SEED, portfolio.key()]`. Lets the owner authorize a
/// browser-held session key to sign `PlaceOrder` (only) without a wallet
/// popup per trade. The delegate can never withdraw — those paths still
/// require the owner — so a leaked session key can trade but not drain funds.
pub const DELEGATE_SEED: &[u8] = b"delegate";

/// PDA seed prefix for a market's oracle authority. Full seeds:
/// `[ORACLE_SEED, market.key()]`. Optional, per-market, owner-rotatable: when
/// set, its key overrides the global relayer constant for that market's
/// `AccrueAsset` price gate. Markets that never set one fall back to the
/// constant, so the existing relayer keeps working unchanged.
pub const ORACLE_SEED: &[u8] = b"oracle";

/// PDA seed prefix for a market's deposit-cap override. Full seeds:
/// `[DEPOSIT_CAP_SEED, market.key()]`. Optional, per-market: when set above the
/// program floor, it raises the per-portfolio collateral cap for a DEX-priced
/// market whose pool depth supports larger positions. It can only raise the cap;
/// the program floor is always enforced.
pub const DEPOSIT_CAP_SEED: &[u8] = b"depositcap";

/// PDA seed prefix for a user's portfolio under a market. Full seed list is
/// `[PORTFOLIO_SEED, owner.key(), market.key()]`. Makes a user's account on a
/// given market group DETERMINISTIC — one account per (owner, market), derivable
/// on any device without a stored keypair or off-chain index. Replaces the old
/// random-keypair-in-localStorage model so the same wallet sees the same
/// accounts/positions on every browser.
pub const PORTFOLIO_SEED: &[u8] = b"portfolio";

/// Magic bytes for a [`DelegateAccount`].
pub const DELEGATE_DISCRIMINATOR: [u8; 8] = *b"OPDELEGT";

/// Magic bytes for an [`OracleAuthorityAccount`].
pub const ORACLE_AUTHORITY_DISCRIMINATOR: [u8; 8] = *b"OPORAUTH";

/// Magic bytes for a [`DepositCapAccount`].
pub const DEPOSIT_CAP_DISCRIMINATOR: [u8; 8] = *b"OPDEPCAP";

/// Tiny PDA holding the session key authorized to place orders for one
/// portfolio. Owner-set; all-zero `delegate` means revoked. `portfolio` binds
/// it to a specific account so `PlaceOrder` can authorize a delegate without
/// re-deriving the PDA (it only ever gets written by the owner via
/// `SetDelegate`, which checks ownership).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct DelegateAccount {
    pub discriminator: [u8; 8],
    pub portfolio: [u8; 32],
    pub delegate: [u8; 32],
}

impl DelegateAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == DELEGATE_DISCRIMINATOR
    }
}

/// Write/overwrite a delegate PDA's payload (owner-authorized off-chain).
pub fn set_delegate_buffer(
    buf: &mut [u8],
    portfolio: [u8; 32],
    delegate: [u8; 32],
) -> Result<(), OpenPerpsError> {
    if buf.len() < DelegateAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &mut DelegateAccount = pod_from_bytes_mut(&mut buf[..DelegateAccount::LEN])?;
    acc.discriminator = DELEGATE_DISCRIMINATOR;
    acc.portfolio = portfolio;
    acc.delegate = delegate;
    Ok(())
}

/// Read a portfolio's owner from immutable account data.
pub fn portfolio_owner(buf: &[u8]) -> Result<[u8; 32], OpenPerpsError> {
    let header_len = core::mem::size_of::<PortfolioAccountV16Account>();
    if buf.len() < header_len {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let header: &PortfolioAccountV16Account =
        bytemuck::try_from_bytes(&buf[..header_len])
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    Ok(header.owner)
}

/// Read `(portfolio, delegate)` from a delegate PDA; delegate is zero if
/// revoked/uninitialized.
pub fn delegate_of(buf: &[u8]) -> Result<([u8; 32], [u8; 32]), OpenPerpsError> {
    if buf.len() < DelegateAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &DelegateAccount = bytemuck::try_from_bytes(&buf[..DelegateAccount::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if !acc.is_initialized() {
        return Ok(([0u8; 32], [0u8; 32]));
    }
    Ok((acc.portfolio, acc.delegate))
}

/// Per-market oracle authority PDA. Optional and owner-rotatable: when present,
/// its `authority` is the only key allowed to MOVE this market's mark via
/// `AccrueAsset`, overriding the global relayer constant. `market` binds it to
/// one market group so the gate can trust it by discriminator + market match.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct OracleAuthorityAccount {
    pub discriminator: [u8; 8],
    pub market: [u8; 32],
    pub authority: [u8; 32],
}

impl OracleAuthorityAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == ORACLE_AUTHORITY_DISCRIMINATOR
    }
}

/// Write/overwrite a market's oracle authority PDA (market-authority-authorized).
/// A zero `authority` revokes it: the gate then falls back to the constant.
pub fn set_oracle_authority_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    authority: [u8; 32],
) -> Result<(), OpenPerpsError> {
    if buf.len() < OracleAuthorityAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &mut OracleAuthorityAccount =
        pod_from_bytes_mut(&mut buf[..OracleAuthorityAccount::LEN])?;
    acc.discriminator = ORACLE_AUTHORITY_DISCRIMINATOR;
    acc.market = market;
    acc.authority = authority;
    Ok(())
}

/// Read `(market, authority)` from an oracle authority PDA; both zero if
/// uninitialized.
pub fn oracle_authority_of(buf: &[u8]) -> Result<([u8; 32], [u8; 32]), OpenPerpsError> {
    if buf.len() < OracleAuthorityAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &OracleAuthorityAccount =
        bytemuck::try_from_bytes(&buf[..OracleAuthorityAccount::LEN])
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if !acc.is_initialized() {
        return Ok(([0u8; 32], [0u8; 32]));
    }
    Ok((acc.market, acc.authority))
}

/// Per-market deposit-cap override PDA. Optional: `max_capital` raises the
/// per-portfolio collateral cap on a DEX-priced market above the program floor.
/// `market` binds it so the cap can be trusted by discriminator + market match.
/// `max_capital` is a little-endian u128 stored as bytes to keep the struct
/// alignment-1 and free of padding (Pod-safe).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct DepositCapAccount {
    pub discriminator: [u8; 8],
    pub market: [u8; 32],
    pub max_capital: [u8; 16],
}

impl DepositCapAccount {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == DEPOSIT_CAP_DISCRIMINATOR
    }
}

/// Write/overwrite a market's deposit-cap override PDA (market-authority-authorized).
pub fn set_deposit_cap_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    max_capital: u128,
) -> Result<(), OpenPerpsError> {
    if buf.len() < DepositCapAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &mut DepositCapAccount = pod_from_bytes_mut(&mut buf[..DepositCapAccount::LEN])?;
    acc.discriminator = DEPOSIT_CAP_DISCRIMINATOR;
    acc.market = market;
    acc.max_capital = max_capital.to_le_bytes();
    Ok(())
}

/// Read `(market, max_capital)` from a deposit-cap PDA; both zero if uninitialized.
pub fn deposit_cap_of(buf: &[u8]) -> Result<([u8; 32], u128), OpenPerpsError> {
    if buf.len() < DepositCapAccount::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let acc: &DepositCapAccount = bytemuck::try_from_bytes(&buf[..DepositCapAccount::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    if !acc.is_initialized() {
        return Ok(([0u8; 32], 0));
    }
    Ok((acc.market, u128::from_le_bytes(acc.max_capital)))
}

/// OpenPerps-owned prefix at the start of a market-group account, in front
/// of the engine's `MarketGroupV16HeaderAccount`. Holds everything the
/// wrapper needs that the engine intentionally leaves out: a stable
/// discriminator, the layout version, the SPL collateral mint, the vault
/// token-account address (a PDA), its bump, and the authority that owns
/// administrative actions like activation.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct OpenPerpsMarketHeader {
    pub discriminator: [u8; 8],
    pub version: u32,
    pub vault_bump: u8,
    /// Bump for the House Vault portfolio's address + owner PDA. Both
    /// derive from `[HOUSE_SEED, market.key()]` with the same bump.
    /// Zero until `CreateHouseVault` runs.
    pub house_bump: u8,
    /// Oracle binding discriminant — see [`oracle_kind`]. `MANUAL` (0) or
    /// `PYTH` (1). Identifies how `effective_price` should be sourced.
    pub oracle_kind: u8,
    pub _pad: [u8; 1],
    /// Whoever signed `InitMarket` — only this key can activate / configure
    /// the market group later, including funding / withdrawing the House.
    pub authority: [u8; 32],
    /// SPL mint accepted as collateral. All deposits/withdrawals on this
    /// market group must reference token accounts of this mint.
    pub quote_mint: [u8; 32],
    /// PDA derived from `[VAULT_SEED, market.key()]` that both *is* the
    /// SPL token account holding pooled collateral and signs transfers out.
    pub vault: [u8; 32],
    /// SPL mint of the *underlying* asset this perp tracks (e.g. wrapped
    /// SOL, BONK, JUP). All-zero for a synthetic with no on-Solana mint
    /// (BTC, ETH) — the market is then defined purely by its oracle feed.
    pub base_mint: [u8; 32],
    /// Pyth pull-oracle feed id (32-byte hex) when `oracle_kind == PYTH`;
    /// all-zero for manual markets. Read by the (future) oracle CPI.
    pub oracle_feed_id: [u8; 32],
    /// On-chain DEX pool account whose reserves price this market when
    /// `oracle_kind == DEX_EWMA`. All-zero otherwise. `CrankOracle` reads
    /// this account, computes the spot price, and EWMA-updates the mark.
    pub oracle_pool: [u8; 32],
}

impl OpenPerpsMarketHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();

    /// A usable OpenPerps market: the discriminator matches AND the layout
    /// version is the one this build understands. Gating on `version` too means
    /// an account written by an older (or future) header layout reads as
    /// uninitialized instead of being silently mis-decoded, forcing an explicit
    /// migration rather than reading stale padding as `oracle_kind` /
    /// `oracle_pool`.
    pub fn is_initialized(&self) -> bool {
        self.discriminator == MARKET_DISCRIMINATOR && self.version == MARKET_HEADER_VERSION
    }
}

// ---------- Mock DEX pool (devnet DEX-EWMA price source) ----------

/// A minimal constant-product (`x·y = k`) AMM pool we deploy on devnet so a
/// market has a *real, on-chain, swap-movable* price to read. On mainnet
/// this would be a Raydium CLMM / pumpswap account instead; the only thing
/// the oracle crank needs is "reserves in, spot price out", and this struct
/// provides exactly that with a layout we control.
///
/// Reserves use the engine's `V16PodU64` (`[u8; 8]`, align 1) so the whole
/// struct is alignment-1 and free of padding — Pod-safe for zero-copy.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct MockPoolHeader {
    pub discriminator: [u8; 8],
    /// Underlying asset mint this pool quotes (display / sanity only).
    pub base_mint: [u8; 32],
    /// Quote mint (the shared mock-USDC).
    pub quote_mint: [u8; 32],
    /// Base-token reserve (virtual units; 6-dp like the quote for simplicity).
    pub reserve_base: V16PodU64,
    /// Quote-token reserve (mock-USDC atoms).
    pub reserve_quote: V16PodU64,
    /// Whoever created the pool — can reseed reserves if ever needed.
    pub authority: [u8; 32],
}

impl MockPoolHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn is_initialized(&self) -> bool {
        self.discriminator == MOCK_POOL_DISCRIMINATOR
    }
}

/// Byte size of a mock-pool account.
pub fn mock_pool_account_size() -> usize {
    MockPoolHeader::LEN
}

/// Read-only view of a mock-pool account.
pub fn mock_pool_header(data: &[u8]) -> Result<&MockPoolHeader, OpenPerpsError> {
    if data.len() < MockPoolHeader::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&data[..MockPoolHeader::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

/// Write a fresh mock-pool header with the given seed reserves.
pub fn init_mock_pool_buffer(
    buf: &mut [u8],
    base_mint: [u8; 32],
    quote_mint: [u8; 32],
    authority: [u8; 32],
    reserve_base: u64,
    reserve_quote: u64,
) -> Result<(), OpenPerpsError> {
    if buf.len() != MockPoolHeader::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    if reserve_base == 0 || reserve_quote == 0 {
        return Err(OpenPerpsError::InvalidInstructionData);
    }
    let pool: &mut MockPoolHeader =
        pod_from_bytes_mut(&mut buf[..MockPoolHeader::LEN])?;
    if pool.is_initialized() {
        return Err(OpenPerpsError::AccountAlreadyInitialized);
    }
    pool.discriminator = MOCK_POOL_DISCRIMINATOR;
    pool.base_mint = base_mint;
    pool.quote_mint = quote_mint;
    pool.authority = authority;
    pool.reserve_base = V16PodU64::new(reserve_base);
    pool.reserve_quote = V16PodU64::new(reserve_quote);
    Ok(())
}

/// Spot price of 1.0 base in quote atoms, scaled by [`PRICE_SCALE`]:
/// `reserve_quote * PRICE_SCALE / reserve_base`.
pub fn mock_pool_spot_price(data: &[u8]) -> Result<u64, OpenPerpsError> {
    let pool = mock_pool_header(data)?;
    let rb = pool.reserve_base.get() as u128;
    let rq = pool.reserve_quote.get() as u128;
    if rb == 0 {
        return Err(OpenPerpsError::InvalidInstructionData);
    }
    let price = rq
        .checked_mul(PRICE_SCALE)
        .ok_or(OpenPerpsError::ArithmeticOverflow)?
        / rb;
    u64::try_from(price).map_err(|_| OpenPerpsError::ArithmeticOverflow)
}

/// Execute a constant-product swap against the pool, mutating reserves.
/// `base_to_quote == true` sells `amount_in` base for quote (pushes price
/// down); `false` buys base with `amount_in` quote (pushes price up).
/// Returns `amount_out`. Pure reserve math — no token CPI; this is a price
/// toy for devnet, not a real custody pool.
pub fn mock_pool_swap_buffer(
    buf: &mut [u8],
    amount_in: u64,
    base_to_quote: bool,
) -> Result<u64, OpenPerpsError> {
    let pool: &mut MockPoolHeader =
        pod_from_bytes_mut(&mut buf[..MockPoolHeader::LEN])?;
    if !pool.is_initialized() {
        return Err(OpenPerpsError::UninitializedAccount);
    }
    if amount_in == 0 {
        return Err(OpenPerpsError::InvalidInstructionData);
    }
    let rb = pool.reserve_base.get() as u128;
    let rq = pool.reserve_quote.get() as u128;
    let k = rb.checked_mul(rq).ok_or(OpenPerpsError::ArithmeticOverflow)?;
    let amt = amount_in as u128;

    let (new_rb, new_rq, amount_out) = if base_to_quote {
        let new_rb = rb.checked_add(amt).ok_or(OpenPerpsError::ArithmeticOverflow)?;
        let new_rq = k / new_rb;
        let out = rq.checked_sub(new_rq).ok_or(OpenPerpsError::ArithmeticOverflow)?;
        (new_rb, new_rq, out)
    } else {
        let new_rq = rq.checked_add(amt).ok_or(OpenPerpsError::ArithmeticOverflow)?;
        let new_rb = k / new_rq;
        let out = rb.checked_sub(new_rb).ok_or(OpenPerpsError::ArithmeticOverflow)?;
        (new_rb, new_rq, out)
    };
    // Keep both reserves positive so the pool never divides by zero later.
    if new_rb == 0 || new_rq == 0 {
        return Err(OpenPerpsError::InvalidInstructionData);
    }
    pool.reserve_base =
        V16PodU64::new(u64::try_from(new_rb).map_err(|_| OpenPerpsError::ArithmeticOverflow)?);
    pool.reserve_quote =
        V16PodU64::new(u64::try_from(new_rq).map_err(|_| OpenPerpsError::ArithmeticOverflow)?);
    u64::try_from(amount_out).map_err(|_| OpenPerpsError::ArithmeticOverflow)
}

/// Read the oracle pool pinned to asset slot `asset_index` (its wrapper).
pub fn slot_oracle_pool(
    buf: &[u8],
    asset_index: u32,
) -> Result<[u8; 32], OpenPerpsError> {
    let wrapper_len = OpenPerpsMarketHeader::LEN;
    let engine_header_len = core::mem::size_of::<MarketGroupV16HeaderAccount>();
    let slot_len = core::mem::size_of::<MarketSlot>();
    let start = wrapper_len
        .checked_add(engine_header_len)
        .and_then(|b| b.checked_add((asset_index as usize).checked_mul(slot_len)?))
        .ok_or(OpenPerpsError::ArithmeticOverflow)?;
    let end = start
        .checked_add(32)
        .ok_or(OpenPerpsError::ArithmeticOverflow)?;
    let bytes = buf
        .get(start..end)
        .ok_or(OpenPerpsError::AccountDataTooSmall)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// Pin `pool` to asset slot `asset_index` by writing its wrapper. Pin-once:
/// fails if the slot already has a non-zero pool. Permissionless — claiming a
/// free slot's oracle is part of permissionless listing.
pub fn set_slot_oracle_pool(
    buf: &mut [u8],
    asset_index: u32,
    pool: [u8; 32],
) -> Result<(), OpenPerpsError> {
    let (_, _, markets) = market_split_mut(buf)?;
    let slot = markets
        .get_mut(asset_index as usize)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    if slot.wrapper != [0u8; 32] {
        return Err(OpenPerpsError::AccountAlreadyInitialized);
    }
    slot.wrapper = pool;
    Ok(())
}

/// DEX-EWMA crank: fold a fresh pool spot price into the market's mark via
/// an on-chain EWMA, then accrue. `old_ema` is the engine slot's current
/// `effective_price` (the EWMA accumulator itself). ActivateMarket seeds
/// `effective_price` with the authenticated activation price, which the engine
/// requires to be non-zero, so the first crank already smooths from that seed
/// rather than from raw pool spot; the `old_ema == 0` branch below is a
/// defensive fallback an active asset never reaches. Permissionless — the price
/// comes from the pool, so any signer may call.
pub fn crank_oracle_buffer(
    market_buf: &mut [u8],
    asset_index: u32,
    spot_price: u64,
    now_slot: u64,
) -> Result<(), V16Error> {
    let old_ema = {
        let (_, markets) =
            market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
        markets
            .get(asset_index as usize)
            .ok_or(V16Error::InvalidConfig)?
            .engine
            .asset
            .effective_price
            .get()
    };
    let new_ema = if old_ema == 0 {
        // Fallback only: an active asset's effective_price was seeded non-zero
        // at activation, so this branch does not run in the normal flow.
        spot_price
    } else {
        ewma_step(old_ema, spot_price, ORACLE_EWMA_ALPHA_BPS)
    };
    // Funding follows the mark-vs-index premium: when the mark (EWMA) is above
    // the pool spot, longs pay shorts (positive rate), and vice-versa. Clamped
    // to the engine's `max_abs_funding_e9_per_slot` (see default_market_config).
    let funding_rate_e9: i128 = if new_ema > spot_price {
        ORACLE_FUNDING_MAX_E9
    } else if new_ema < spot_price {
        -ORACLE_FUNDING_MAX_E9
    } else {
        0
    };
    accrue_asset_buffer(
        market_buf,
        asset_index,
        now_slot,
        new_ema,
        funding_rate_e9,
        /* protective */ true,
    )
}

/// `new = old + α·(spot − old)`, α = `alpha_bps / 10_000`. Saturates at 0.
fn ewma_step(old: u64, spot: u64, alpha_bps: u64) -> u64 {
    let old_i = old as i128;
    let delta = (spot as i128 - old_i) * alpha_bps as i128 / 10_000;
    let next = old_i + delta;
    if next < 0 {
        0
    } else {
        next as u64
    }
}

// ---------- size helpers ----------

/// Byte size of a market-group account holding `asset_slot_capacity` slots,
/// including the OpenPerps wrapper-header prefix.
pub fn market_account_size(asset_slot_capacity: usize) -> Result<usize, OpenPerpsError> {
    let engine = MarketGroupV16HeaderAccount::dynamic_market_group_account_len::<MarketWrapper>(
        asset_slot_capacity,
    )
    .map_err(|_| OpenPerpsError::ArithmeticOverflow)?;
    OpenPerpsMarketHeader::LEN
        .checked_add(engine)
        .ok_or(OpenPerpsError::ArithmeticOverflow)
}

/// Number of source domains a portfolio account needs for a market group with
/// `asset_slot_capacity` market slots. Mirrors
/// `v16_domain_count_for_market_slots`: two domains (long, short) per slot.
pub fn portfolio_source_domain_count(asset_slot_capacity: usize) -> Result<usize, OpenPerpsError> {
    asset_slot_capacity
        .checked_mul(2)
        .ok_or(OpenPerpsError::ArithmeticOverflow)
}

/// Byte size of a portfolio account paired with a market group of
/// `asset_slot_capacity` slots.
pub fn portfolio_account_size(asset_slot_capacity: usize) -> Result<usize, OpenPerpsError> {
    let domain_count = portfolio_source_domain_count(asset_slot_capacity)?;
    let header = core::mem::size_of::<PortfolioAccountV16Account>();
    let domains = domain_count
        .checked_mul(core::mem::size_of::<PortfolioSourceDomainV16Account>())
        .ok_or(OpenPerpsError::ArithmeticOverflow)?;
    header
        .checked_add(domains)
        .ok_or(OpenPerpsError::ArithmeticOverflow)
}

// ---------- split helpers ----------

/// Split a market-group account's mutable data into
/// `(wrapper_header, engine_header, markets)`. The wrapper header is
/// OpenPerps-owned metadata (mint, vault, authority); the engine header and
/// the market slot array are the percolator zero-copy view's input.
pub fn market_split_mut(
    data: &mut [u8],
) -> Result<
    (
        &mut OpenPerpsMarketHeader,
        &mut MarketGroupV16HeaderAccount,
        &mut [MarketSlot],
    ),
    OpenPerpsError,
> {
    let wrapper_len = OpenPerpsMarketHeader::LEN;
    let engine_header_len = core::mem::size_of::<MarketGroupV16HeaderAccount>();
    if data.len() < wrapper_len + engine_header_len {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let (wrap_bytes, rest) = data.split_at_mut(wrapper_len);
    let (engine_bytes, slot_bytes) = rest.split_at_mut(engine_header_len);
    let wrapper: &mut OpenPerpsMarketHeader = pod_from_bytes_mut(wrap_bytes)?;
    let engine: &mut MarketGroupV16HeaderAccount = pod_from_bytes_mut(engine_bytes)?;
    let markets: &mut [MarketSlot] = bytemuck::try_cast_slice_mut(slot_bytes)
        .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    Ok((wrapper, engine, markets))
}

/// Split engine-only view of a market-group account (skipping the wrapper
/// prefix) for paths that don't need OpenPerps metadata. Convenience shim
/// over [`market_split_mut`].
pub fn market_engine_split_mut(
    data: &mut [u8],
) -> Result<(&mut MarketGroupV16HeaderAccount, &mut [MarketSlot]), OpenPerpsError> {
    let (_, engine, markets) = market_split_mut(data)?;
    Ok((engine, markets))
}

/// Split a portfolio account's mutable data into `(header, source_domains)`.
pub fn portfolio_split_mut(
    data: &mut [u8],
) -> Result<
    (
        &mut PortfolioAccountV16Account,
        &mut [PortfolioSourceDomainV16Account],
    ),
    OpenPerpsError,
> {
    let header_len = core::mem::size_of::<PortfolioAccountV16Account>();
    if data.len() < header_len {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let (head_bytes, rest) = data.split_at_mut(header_len);
    let header: &mut PortfolioAccountV16Account = pod_from_bytes_mut(head_bytes)?;
    let domains: &mut [PortfolioSourceDomainV16Account] =
        bytemuck::try_cast_slice_mut(rest).map_err(|_| OpenPerpsError::InvalidAccountData)?;
    Ok((header, domains))
}

/// Read-only access to a market account's engine header (skipping the
/// OpenPerps wrapper prefix). Useful for cross-account lookups during
/// portfolio init.
pub fn market_header(data: &[u8]) -> Result<&MarketGroupV16HeaderAccount, OpenPerpsError> {
    let wrapper_len = OpenPerpsMarketHeader::LEN;
    let engine_header_len = core::mem::size_of::<MarketGroupV16HeaderAccount>();
    if data.len() < wrapper_len + engine_header_len {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&data[wrapper_len..wrapper_len + engine_header_len])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

/// Read-only access to the OpenPerps wrapper header.
pub fn market_wrapper_header(
    data: &[u8],
) -> Result<&OpenPerpsMarketHeader, OpenPerpsError> {
    if data.len() < OpenPerpsMarketHeader::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&data[..OpenPerpsMarketHeader::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

// ---------- config ----------

/// A minimum-viable `V16ConfigAccount` that satisfies
/// `validate_public_user_fund_shape` (called by the engine's `validate_shape`
/// on every state-mutating op). Field values are deliberately small / lax
/// where deposit doesn't read them; later instructions (trade, fund) will
/// expose real values through the SDK.
pub fn default_market_config(asset_slot_capacity: u32) -> V16ConfigAccount {
    let mut c = V16ConfigAccount::default();

    let max_portfolio = core::cmp::min(asset_slot_capacity, V16_MAX_PORTFOLIO_ASSETS_N as u32);
    c.max_portfolio_assets = V16PodU16::new(max_portfolio as u16);
    c.max_market_slots = V16PodU32::new(asset_slot_capacity);

    // h-lock: any positive h_max with h_min ≤ h_max works for shape validation.
    c.h_min = V16PodU64::new(0);
    c.h_max = V16PodU64::new(1);

    // Margin floors: mm < im, both > 0; bps ordering and ≤ 10_000.
    c.min_nonzero_mm_req = V16PodU128::new(1);
    c.min_nonzero_im_req = V16PodU128::new(2);
    c.maintenance_margin_bps = V16PodU64::new(500);
    c.initial_margin_bps = V16PodU64::new(1_000);
    c.max_trading_fee_bps = V16PodU64::new(10);
    c.liquidation_fee_bps = V16PodU64::new(50);
    c.liquidation_fee_cap = V16PodU128::new(1_000_000_000);
    c.min_liquidation_abs = V16PodU128::new(1);

    // Funding / oracle bounds (all > 0 where required).
    //
    // `max_accrual_dt_slots` is how many slots a single AccrueAsset can advance
    // an asset's `slot_last`. It must comfortably exceed the slots that elapse
    // between off-chain relayer pushes (~150 devnet slots per 1-min cron), or
    // `slot_last` falls permanently behind `now_slot` and the engine raises a
    // group-wide stale-loss lock (LockActive on every new position). We set it
    // to 1000 (~6.7 min) so one push per minute always fully catches up.
    //
    // The solvency envelope only constrains the PRODUCTS
    // `max_price_move_bps_per_slot * max_accrual_dt_slots` and
    // `max_abs_funding_e9_per_slot * max_accrual_dt_slots`; we keep both equal
    // to the previously-validated config (100*100 = 1000*10) by scaling the
    // per-slot caps down 10x, so the Kani-verified envelope is unchanged.
    c.max_accrual_dt_slots = V16PodU64::new(1_000);
    c.max_abs_funding_e9_per_slot = V16PodU64::new(10);
    c.min_funding_lifetime_slots = V16PodU64::new(1_000);
    c.max_price_move_bps_per_slot = V16PodU64::new(10);

    // Recovery / bankruptcy chunking knobs (all > 0 where required).
    c.max_account_b_settlement_chunks = V16PodU64::new(1);
    c.max_bankrupt_close_chunks = V16PodU64::new(1);
    // Also the dominant input to the source-credit backing-bucket freshness
    // horizon: `max(max_accrual_dt_slots, h_max, max_bankrupt_close_lifetime_slots)`.
    // When a position opens, the counterparty (House) backing bucket gets
    // `expiry_slot = current_slot + horizon`; once it expires, settling the
    // House validates its domains and reverts every trade with `Stale`. The
    // off-chain relayer advances `current_slot` ~150 slots/min, so a small
    // horizon (e.g. 100–1000 slots) expires House backing within minutes and
    // bricks trading. Set it huge (~1e9 slots ≈ years) so backing never
    // expires under the live-price relayer. It only loosens a bankruptcy
    // lifetime ceiling and is unconstrained by the solvency envelope.
    c.max_bankrupt_close_lifetime_slots = V16PodU64::new(1_000_000_000);
    c.asset_activation_cooldown_slots = V16PodU64::new(1);
    c.public_b_chunk_atoms = V16PodU128::new(1);
    c.max_recovery_fallback_deviation_bps = V16PodU64::new(0);

    // Backing-fee curve: zero rates pass when kink_util_bps ∈ (0, 10_000) and
    // freshness_buckets ∈ [1, V16_BACKING_BUCKETS_PER_DOMAIN].
    c.backing_fee_kink_util_bps = V16PodU64::new(5_000);
    c.backing_freshness_buckets = 1;

    // All policy bool flags must be ON for public-user-fund shape to validate.
    c.margin_mode_realizable_full_shared_cross_margin = TRUE;
    c.source_credit_lien_required = TRUE;
    c.insurance_credit_reservation_required = TRUE;
    c.permissionless_recovery_enabled = TRUE;
    c.recovery_fallback_price_enabled = TRUE;
    c.recovery_fallback_envelope_enabled = TRUE;
    c.credit_lien_revalidation_required = TRUE;
    c.stale_certificate_penalty_enabled = TRUE;
    c.full_refresh_required_for_favorable_actions = TRUE;
    c.public_liveness_profile_crank_forward = TRUE;

    c
}

// ---------- buffer initializers (shared with tests) ----------

/// Write a fresh wrapper header + engine header + slot table over `buf`.
/// The buffer must be exactly `market_account_size(asset_slot_capacity)`
/// bytes long and zero-initialized (Solana System Program guarantees this
/// on `CreateAccount`).
///
/// `vault` is the PDA derived from `[VAULT_SEED, market.key()]`; the on-chain
/// handler derives it (and records `vault_bump`) before calling this. In
/// host tests it can be any 32 bytes — the engine doesn't touch the wrapper
/// fields.
pub fn init_market_buffer(
    buf: &mut [u8],
    market_group_id: [u8; 32],
    asset_slot_capacity: u32,
    authority: [u8; 32],
    quote_mint: [u8; 32],
    vault: [u8; 32],
    vault_bump: u8,
    base_mint: [u8; 32],
    oracle_kind: u8,
    oracle_feed_id: [u8; 32],
    oracle_pool: [u8; 32],
) -> Result<(), OpenPerpsError> {
    if buf.len() != market_account_size(asset_slot_capacity as usize)? {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let (wrapper, engine, markets) = market_split_mut(buf)?;
    if wrapper.is_initialized() || engine.market_group_id != [0u8; 32] {
        return Err(OpenPerpsError::AccountAlreadyInitialized);
    }

    // --- OpenPerps wrapper header ---
    wrapper.discriminator = MARKET_DISCRIMINATOR;
    wrapper.version = MARKET_HEADER_VERSION;
    wrapper.vault_bump = vault_bump;
    wrapper.oracle_kind = oracle_kind;
    wrapper.authority = authority;
    wrapper.quote_mint = quote_mint;
    wrapper.vault = vault;
    wrapper.base_mint = base_mint;
    wrapper.oracle_feed_id = oracle_feed_id;
    wrapper.oracle_pool = oracle_pool;

    // --- Engine header ---
    engine.market_group_id = market_group_id;
    engine.config = default_market_config(asset_slot_capacity);
    engine.asset_slot_capacity = V16PodU32::new(asset_slot_capacity);
    // Slots stay at their zero / Disabled defaults — see ActivateMarket.
    let _ = markets;
    engine.next_market_id = V16PodU64::new(1);
    Ok(())
}

/// Write a fresh portfolio header over `buf` for the given market group.
pub fn init_portfolio_buffer(
    buf: &mut [u8],
    market_group_id: [u8; 32],
    portfolio_account_id: [u8; 32],
    owner: [u8; 32],
) -> Result<(), V16Error> {
    let (header, _domains) =
        portfolio_split_mut(buf).map_err(|_| V16Error::InvalidConfig)?;
    if header.provenance_header.market_group_id != [0u8; 32] {
        return Err(V16Error::ProvenanceMismatch);
    }
    // We deliberately avoid `PortfolioAccountV16Account::try_empty` here:
    // that constructor returns a ~2.9KB struct by value, which blows the
    // SBF 4KB stack frame limit on `cargo build-sbf` (we saw a 5824-byte
    // frame warning). Instead we write the few non-zero fields directly
    // into the account buffer — every field `try_empty` would have set to
    // zero is *already* zero (Solana System Program zero-initializes fresh
    // account data, and our double-init guard above guarantees we got
    // here from that state). Then we re-encode each leg to the engine's
    // empty pattern (a_basis = ADL_ONE), without which `validate_with_market`
    // would reject the zero-byte legs as `HiddenLeg`.
    let prov = ProvenanceHeaderV16::new(market_group_id, portfolio_account_id, owner);
    let prov_acct = ProvenanceHeaderV16Account::from_runtime(&prov);
    // Verify version + layout discriminator are sane (mirrors the check
    // `PortfolioAccountV16Account::try_empty` would have done via
    // `header.try_to_runtime()`).
    prov_acct.try_to_runtime()?;
    header.provenance_header = prov_acct;
    header.owner = owner;
    let empty_leg = PortfolioLegV16Account::from_runtime(&PortfolioLegV16::EMPTY);
    for slot in header.legs.iter_mut() {
        *slot = empty_leg;
    }
    Ok(())
}

/// Transition the asset slot at `asset_index` from `Disabled` to `Active` with
/// an authenticated oracle price. `now_slot` must come from the on-chain
/// `Clock` sysvar at the call site (the host integration tests pass a synthetic
/// slot; the program handler reads `Clock::get()`).
pub fn activate_market_buffer(
    buf: &mut [u8],
    asset_index: u32,
    authenticated_price: u64,
    now_slot: u64,
) -> Result<(), V16Error> {
    let (header, markets) =
        market_engine_split_mut(buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(header, markets);
    mg.activate_empty_market_not_atomic(asset_index, authenticated_price, now_slot)
}

/// Refresh the oracle price and accrue funding for an already-active asset
/// slot. Bundles oracle + funding update because that is the engine's atomic
/// unit (see `MarketGroupV16ViewMut::accrue_asset_to_not_atomic`).
///
/// `protective_progress_committed` is hardcoded to `false`: that flag is only
/// required when the slot has open positions *and* the price move exceeds
/// `max_price_move_bps_per_slot * dt`. With no positions `activity.equity_active`
/// is false and the strict branch is skipped. The trade instruction may need
/// to flip this on once we support open-position accruals.
///
/// **`raw_oracle_target_price` patch:** the engine's `accrue` updates
/// `effective_price` and `fund_px_last` but deliberately leaves
/// `raw_oracle_target_price` alone — that field is meant to be set by a
/// separately-attested oracle CPI (Pyth/Switchboard), and any mismatch makes
/// `asset_has_target_effective_lag` return true, which blocks risk-increasing
/// trades with `LockActive`. For the MVP trust model the signer *is* the
/// oracle, so we patch `raw_oracle_target_price = effective_price` after the
/// engine call. Replace this with a real oracle CPI before going to mainnet.
pub fn accrue_asset_buffer(
    buf: &mut [u8],
    asset_index: u32,
    now_slot: u64,
    effective_price: u64,
    funding_rate_e9: i128,
    protective: bool,
) -> Result<(), V16Error> {
    {
        let (header, markets) =
            market_engine_split_mut(buf).map_err(|_| V16Error::InvalidConfig)?;
        let mut mg = MarketGroupV16ViewMut::new(header, markets);
        // `protective_progress_committed` must be true once an asset has open
        // exposure and its price moves or funding accrues, or the engine
        // returns `NonProgress`. The engine still independently enforces the
        // per-slot price-move bound (→ RecoveryRequired) before accepting it,
        // so the oracle crank asserts it after the EWMA produces a bounded
        // move. Production should recertify / liquidate first; on devnet the
        // bounded EWMA is the protection.
        mg.accrue_asset_to_not_atomic(
            asset_index as usize,
            now_slot,
            effective_price,
            funding_rate_e9,
            protective,
        )?;
    }
    // Engine validated asset_index above; re-borrow and patch the trusted
    // oracle target to match the mark we just accepted.
    let (_, markets) =
        market_engine_split_mut(buf).map_err(|_| V16Error::InvalidConfig)?;
    markets[asset_index as usize]
        .engine
        .asset
        .raw_oracle_target_price = V16PodU64::new(effective_price);
    Ok(())
}

/// Symmetric counterpart to `deposit_not_atomic`: debit `amount` from the
/// portfolio's capital and from the market's vault counter. The engine
/// requires the portfolio to be position-free (active_bitmap empty,
/// close_progress empty) and `pnl >= 0`; mode must be Live; amount ≤
/// capital. The CPI side (moving SPL tokens out of the vault PDA) is the
/// handler's job, not the engine's.
pub fn withdraw_buffer(
    market_buf: &mut [u8],
    portfolio_buf: &mut [u8],
    amount: u128,
) -> Result<(), V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (p_h, p_d) = portfolio_split_mut(portfolio_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut pv = PortfolioV16ViewMut::new(p_h, p_d);
    mg.withdraw_not_atomic(&mut pv, amount)
}

/// Engine-only deposit helper — symmetric to [`withdraw_buffer`]. The
/// handler is responsible for owner/authority checks and SPL token CPI;
/// this just runs the engine math. Reused by both the user-facing
/// `Deposit` instruction and the House Vault's `FundHouseVault`.
pub fn deposit_buffer(
    market_buf: &mut [u8],
    portfolio_buf: &mut [u8],
    amount: u128,
) -> Result<(), V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (p_h, p_d) = portfolio_split_mut(portfolio_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut pv = PortfolioV16ViewMut::new(p_h, p_d);
    mg.deposit_not_atomic(&mut pv, amount)
}

/// Liquidate `close_q` of the active leg at `asset_index` on `account`.
/// Permissionless from the engine's perspective — anyone can call — but
/// engine refuses unless the account's certified liquidation deficit is
/// non-zero (`V16Error::NonProgress`). The wrapper handler just enforces
/// signer/writability + that the engine returned an outcome.
pub fn liquidate_buffer(
    market_buf: &mut [u8],
    portfolio_buf: &mut [u8],
    asset_index: u32,
    close_q: u128,
    fee_bps: u64,
) -> Result<LiquidationOutcomeV16, V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (p_h, p_d) = portfolio_split_mut(portfolio_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut pv = PortfolioV16ViewMut::new(p_h, p_d);
    mg.liquidate_account_not_atomic(
        &mut pv,
        LiquidationRequestV16 {
            asset_index: asset_index as usize,
            close_q,
            fee_bps,
        },
    )
}

/// Flip the market from `Live` to `Resolved` at `resolved_slot`. Engine
/// refuses while the market is already in Recovery; the wrapper additionally
/// pins this to the authority (resolve is one-way).
pub fn resolve_market_buffer(
    buf: &mut [u8],
    resolved_slot: u64,
) -> Result<(), V16Error> {
    let (h, m) = market_engine_split_mut(buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(h, m);
    mg.resolve_market_not_atomic(resolved_slot)
}

/// Permissionless crank with the `Refresh` action — re-certifies a
/// portfolio against fresh oracle and funding inputs. Used by keepers to
/// keep account health up to date independent of user activity.
///
/// Engine variants (`SettleB`, `Liquidate`, `Recover`) get their own
/// dedicated instructions or rely on `Liquidate` directly; we expose
/// just `Refresh` from the crank surface for now.
pub fn crank_refresh_buffer(
    market_buf: &mut [u8],
    portfolio_buf: &mut [u8],
    now_slot: u64,
    asset_index: u32,
    effective_price: u64,
    funding_rate_e9: i128,
) -> Result<(), V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (p_h, p_d) = portfolio_split_mut(portfolio_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut pv = PortfolioV16ViewMut::new(p_h, p_d);
    mg.permissionless_crank_not_atomic(
        &mut pv,
        PermissionlessCrankRequestV16 {
            now_slot,
            asset_index: asset_index as usize,
            effective_price,
            funding_rate_e9,
            action: PermissionlessCrankActionV16::Refresh,
        },
    )?;
    Ok(())
}

/// Cross a matched long/short trade through the engine. The engine is
/// allergic to single-sided "open vs market maker" calls — every fill is a
/// two-account cross. Both portfolios must be initialized against the same
/// market group; a single authority signs in the on-chain handler.
///
/// Returns the engine's `TradeOutcomeV16` (per-side fees + notional) so
/// callers can verify or surface the result.
/// Convert a user account's released positive PnL into withdrawable `capital`
/// via the engine's `convert_released_pnl_to_capital_not_atomic`. The realizable
/// amount is backed by the source-credit the engine reserved from the
/// counterparty (the House) when the position opened, so no House account is
/// touched here. Returns the amount converted; vault and c_tot stay conserved.
///
/// Replaces the old `settle_realized_pnl_not_atomic` (House-debit) path, which
/// upstream Percolator removed in favor of this single-account primitive.
pub fn settle_pnl_buffer(
    market_buf: &mut [u8],
    user_buf: &mut [u8],
) -> Result<u128, V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (u_h, u_d) = portfolio_split_mut(user_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut user = PortfolioV16ViewMut::new(u_h, u_d);
    mg.convert_released_pnl_to_capital_not_atomic(&mut user)
}

pub fn trade_buffer(
    market_buf: &mut [u8],
    long_buf: &mut [u8],
    short_buf: &mut [u8],
    asset_index: u32,
    size_q: u128,
    exec_price: u64,
    fee_bps: u64,
) -> Result<TradeOutcomeV16, V16Error> {
    let (m_h, m_s) =
        market_engine_split_mut(market_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (l_h, l_d) = portfolio_split_mut(long_buf).map_err(|_| V16Error::InvalidConfig)?;
    let (s_h, s_d) = portfolio_split_mut(short_buf).map_err(|_| V16Error::InvalidConfig)?;
    let mut mg = MarketGroupV16ViewMut::new(m_h, m_s);
    let mut long = PortfolioV16ViewMut::new(l_h, l_d);
    let mut short = PortfolioV16ViewMut::new(s_h, s_d);
    mg.execute_trade_with_fee_in_place_not_atomic(
        &mut long,
        &mut short,
        TradeRequestV16 {
            asset_index: asset_index as usize,
            size_q,
            exec_price,
            fee_bps,
        },
    )
}

// ---------- internals ----------

/// Safe wrapper around `bytemuck::from_bytes_mut` that converts an alignment /
/// size mismatch into our error type instead of panicking.
fn pod_from_bytes_mut<T: Pod + Zeroable>(bytes: &mut [u8]) -> Result<&mut T, OpenPerpsError> {
    bytemuck::try_from_bytes_mut(bytes).map_err(|_| OpenPerpsError::InvalidAccountData)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the byte-size test reads these engine struct layouts, so importing
    // them here keeps the non-test build free of unused-import warnings.
    use percolator::v16::{AssetStateV16Account, EngineAssetSlotV16Account};

    #[test]
    fn market_size_grows_with_capacity() {
        let wrapper = OpenPerpsMarketHeader::LEN;
        let engine = core::mem::size_of::<MarketGroupV16HeaderAccount>();
        let slot = core::mem::size_of::<MarketSlot>();
        assert_eq!(market_account_size(0).unwrap(), wrapper + engine);
        assert_eq!(market_account_size(4).unwrap(), wrapper + engine + 4 * slot);
    }

    #[test]
    fn wrapper_header_layout_is_stable() {
        // v4: discriminator(8) + version(4) + vault_bump(1) + house_bump(1)
        // + oracle_kind(1) + pad(1) + authority(32) + quote_mint(32)
        // + vault(32) + base_mint(32) + oracle_feed_id(32) + oracle_pool(32)
        // = 208 bytes. The SDK and the on-chain handler both rely on this
        // size; if it changes, bump MARKET_HEADER_VERSION and update layout.ts.
        assert_eq!(OpenPerpsMarketHeader::LEN, 208);
    }

    #[test]
    fn mock_pool_layout_is_stable() {
        // discriminator(8) + base_mint(32) + quote_mint(32) + reserve_base(8)
        // + reserve_quote(8) + authority(32) = 120 bytes.
        assert_eq!(MockPoolHeader::LEN, 120);
    }

    #[test]
    fn ewma_step_moves_toward_spot_and_saturates() {
        // α = 0.2: from 100 toward 200 → 100 + 0.2*100 = 120.
        assert_eq!(ewma_step(100, 200, 2_000), 120);
        // Downward: from 100 toward 0 → 100 - 0.2*100 = 80.
        assert_eq!(ewma_step(100, 0, 2_000), 80);
        // Repeated steps converge upward toward spot, never overshoot.
        let mut p = 100u64;
        for _ in 0..50 {
            p = ewma_step(p, 200, 2_000);
            assert!(p <= 200);
        }
        assert!(p > 190, "should converge near spot: {p}");
    }

    #[test]
    fn delegate_buffer_roundtrip() {
        let mut buf = vec![0u8; DelegateAccount::LEN];
        // uninitialized → zero delegate
        assert_eq!(delegate_of(&buf).unwrap(), ([0u8; 32], [0u8; 32]));
        set_delegate_buffer(&mut buf, [7u8; 32], [9u8; 32]).unwrap();
        assert_eq!(delegate_of(&buf).unwrap(), ([7u8; 32], [9u8; 32]));
        // revoke
        set_delegate_buffer(&mut buf, [7u8; 32], [0u8; 32]).unwrap();
        let (pf, del) = delegate_of(&buf).unwrap();
        assert_eq!(pf, [7u8; 32]);
        assert_eq!(del, [0u8; 32]);
    }

    #[test]
    fn oracle_authority_buffer_roundtrip() {
        let mut buf = vec![0u8; OracleAuthorityAccount::LEN];
        // uninitialized → zeros
        assert_eq!(oracle_authority_of(&buf).unwrap(), ([0u8; 32], [0u8; 32]));
        set_oracle_authority_buffer(&mut buf, [3u8; 32], [9u8; 32]).unwrap();
        assert_eq!(oracle_authority_of(&buf).unwrap(), ([3u8; 32], [9u8; 32]));
        // revoke (zero authority): market stays, authority clears → const fallback
        set_oracle_authority_buffer(&mut buf, [3u8; 32], [0u8; 32]).unwrap();
        assert_eq!(oracle_authority_of(&buf).unwrap(), ([3u8; 32], [0u8; 32]));
    }

    #[test]
    fn deposit_cap_buffer_roundtrip() {
        let mut buf = vec![0u8; DepositCapAccount::LEN];
        // uninitialized → zeros
        assert_eq!(deposit_cap_of(&buf).unwrap(), ([0u8; 32], 0));
        set_deposit_cap_buffer(&mut buf, [4u8; 32], 50_000_000_000).unwrap();
        assert_eq!(deposit_cap_of(&buf).unwrap(), ([4u8; 32], 50_000_000_000));
    }

    #[test]
    fn portfolio_owner_reads_back() {
        let mut buf = vec![0u8; portfolio_account_size(2).unwrap()];
        init_portfolio_buffer(&mut buf, [1u8; 32], [2u8; 32], [0xABu8; 32]).unwrap();
        assert_eq!(portfolio_owner(&buf).unwrap(), [0xABu8; 32]);
    }

    #[test]
    fn slot_oracle_pool_pin_once() {
        let mut buf = vec![0u8; market_account_size(2).unwrap()];
        init_market_buffer(
            &mut buf, [9u8; 32], 2, [1u8; 32], [2u8; 32], [3u8; 32], 0, [0u8; 32], 0,
            [0u8; 32], [0u8; 32],
        )
        .unwrap();
        // Unset slots read all-zero.
        assert_eq!(slot_oracle_pool(&buf, 0).unwrap(), [0u8; 32]);
        // Pin slot 1, leave slot 0.
        set_slot_oracle_pool(&mut buf, 1, [7u8; 32]).unwrap();
        assert_eq!(slot_oracle_pool(&buf, 1).unwrap(), [7u8; 32]);
        assert_eq!(slot_oracle_pool(&buf, 0).unwrap(), [0u8; 32]);
        // Pin-once: second pin on the same slot fails.
        assert!(set_slot_oracle_pool(&mut buf, 1, [8u8; 32]).is_err());
        // Out-of-range slot fails.
        assert!(set_slot_oracle_pool(&mut buf, 9, [1u8; 32]).is_err());
    }

    #[test]
    fn mock_pool_swap_moves_price() {
        // x*y=k: start 1_000_000 base / 100_000_000 quote → spot = 100.0.
        let mut buf = vec![0u8; MockPoolHeader::LEN];
        init_mock_pool_buffer(&mut buf, [1u8; 32], [2u8; 32], [3u8; 32], 1_000_000, 100_000_000)
            .unwrap();
        let spot0 = mock_pool_spot_price(&buf).unwrap();
        assert_eq!(spot0, 100 * PRICE_SCALE as u64);
        // Buy base with quote → base reserve falls, price rises.
        mock_pool_swap_buffer(&mut buf, 10_000_000, /* quote_to_base */ false).unwrap();
        let spot1 = mock_pool_spot_price(&buf).unwrap();
        assert!(spot1 > spot0, "buying base should push price up: {spot1} !> {spot0}");
    }

    #[test]
    fn portfolio_split_yields_right_domain_count() {
        let cap = 4;
        let mut buf = vec![0u8; portfolio_account_size(cap).unwrap()];
        let (_header, domains) = portfolio_split_mut(&mut buf).unwrap();
        assert_eq!(domains.len(), portfolio_source_domain_count(cap).unwrap());
    }

    #[test]
    fn print_byte_sizes_for_sdk() {
        // Run with `cargo test -p openperps-program print_byte_sizes -- --nocapture`
        // to recover the constants the TS SDK uses to size accounts.
        println!(
            "WRAPPER_HEADER={} MARKET_HEADER={} MARKET_SLOT={} PORTFOLIO_HEADER={} SOURCE_DOMAIN={}",
            OpenPerpsMarketHeader::LEN,
            core::mem::size_of::<MarketGroupV16HeaderAccount>(),
            core::mem::size_of::<MarketSlot>(),
            core::mem::size_of::<PortfolioAccountV16Account>(),
            core::mem::size_of::<PortfolioSourceDomainV16Account>(),
        );
        println!(
            "OFFSET_VAULT={} OFFSET_CTOT={} OFFSET_CAPITAL={} OFFSET_PNL={}",
            core::mem::offset_of!(MarketGroupV16HeaderAccount, vault),
            core::mem::offset_of!(MarketGroupV16HeaderAccount, c_tot),
            core::mem::offset_of!(PortfolioAccountV16Account, capital),
            core::mem::offset_of!(PortfolioAccountV16Account, pnl),
        );
        println!(
            "SLOT_EFFECTIVE_PRICE_OFFSET={}",
            // Nested `offset_of!` (a.b.c) is unstable on Rust 1.80, so sum the
            // offset of each level: MarketSlot.engine -> .asset -> .effective_price.
            core::mem::offset_of!(MarketSlot, engine)
                + core::mem::offset_of!(EngineAssetSlotV16Account, asset)
                + core::mem::offset_of!(AssetStateV16Account, effective_price),
        );
        println!(
            "LEGS_OFFSET={} LEG_SIZE={} LEG_ASSET_IDX={} LEG_SIDE={} LEG_BASIS={} LEG_COUNT={}",
            core::mem::offset_of!(PortfolioAccountV16Account, legs),
            core::mem::size_of::<PortfolioLegV16Account>(),
            core::mem::offset_of!(PortfolioLegV16Account, asset_index),
            core::mem::offset_of!(PortfolioLegV16Account, side),
            core::mem::offset_of!(PortfolioLegV16Account, basis_pos_q),
            V16_MAX_PORTFOLIO_ASSETS_N,
        );
    }

    #[test]
    fn default_config_passes_engine_shape_check() {
        // Encode → decode round-trip via `try_to_runtime_shape` exercises
        // `validate_public_user_fund_shape`, which is what `validate_shape`
        // calls during every state-mutating engine op.
        let cfg = default_market_config(4);
        assert!(cfg.try_to_runtime_shape().is_ok());
    }
}
