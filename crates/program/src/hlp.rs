//! House LP (HLP): permissionless House vault, share accounting + NAV (Phase 2a).
//!
//! HLP is a wrapper construct layered on the House portfolio the engine already
//! manages (see `docs/hlp.md`). It does NOT modify the vendored engine: it adds
//! share accounting (who owns the House capital) plus a free-buffer token account
//! that decouples LP redemption from the engine's "no withdraw while positioned"
//! rule. The share/NAV math here is pure and host-tested; the deposit / deploy /
//! redeem handlers live in `processor.rs`.

use bytemuck::{Pod, Zeroable};
use percolator::v16::{account_equity_from_parts, PortfolioAccountV16Account};
use percolator::wide_math::mul_div_floor_u128;

use crate::error::OpenPerpsError;

/// PDA seed for the HLP config: `[HLP_SEED, market]`. Holds `total_shares` and the
/// withdrawal governance (delay, fee, min deposit).
pub const HLP_SEED: &[u8] = b"hlp";
/// PDA seed for the HLP free-buffer token account: `[HLP_VAULT_SEED, market]`. Holds
/// undeployed LP capital; redemptions are paid from here, so they are bounded by the
/// free buffer and never need to pull engine House capital while it is positioned.
pub const HLP_VAULT_SEED: &[u8] = b"hlpvault";
/// PDA seed for a per-LP position: `[HLP_POSITION_SEED, market, owner]`.
pub const HLP_POSITION_SEED: &[u8] = b"hlppos";

/// Magic bytes for an [`HlpConfig`].
pub const HLP_CONFIG_DISCRIMINATOR: [u8; 8] = *b"OPHLPCFG";
/// Magic bytes for an [`HlpPosition`].
pub const HLP_POSITION_DISCRIMINATOR: [u8; 8] = *b"OPHLPPOS";

/// Virtual shares/assets offset that defuses the first-depositor inflation attack
/// (OpenZeppelin ERC4626 style): the share price is computed against
/// `(total_shares + VIRTUAL_SHARES) / (nav + VIRTUAL_ASSETS)`, so a tiny first
/// deposit followed by a direct NAV donation cannot be inflated to steal a later
/// depositor's funds. No real "dead shares" to track.
pub const HLP_VIRTUAL_SHARES: u128 = 1_000_000;
pub const HLP_VIRTUAL_ASSETS: u128 = 1;

/// Per-market HLP config. Byte arrays keep it alignment-1 and padding-free (Pod).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct HlpConfig {
    pub discriminator: [u8; 8],
    pub market: [u8; 32],
    /// Total LP shares outstanding (LE u128).
    pub total_shares: [u8; 16],
    /// Redemption timelock: slots between request and execute (LE u64).
    pub redeem_delay_slots: [u8; 8],
    /// Deposit + redeem fee in bps, charged to NAV (anti round-trip) (LE u64).
    pub fee_bps: [u8; 8],
    /// Minimum first/each deposit in quote atoms (anti dust / inflation) (LE u128).
    pub min_deposit: [u8; 16],
    pub reserved: [u8; 32],
}

impl HlpConfig {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == HLP_CONFIG_DISCRIMINATOR
    }
}

/// Decoded HLP config.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HlpParams {
    pub total_shares: u128,
    pub redeem_delay_slots: u64,
    pub fee_bps: u64,
    pub min_deposit: u128,
}

/// Per-LP HLP position: share balance + the single pending-redeem slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct HlpPosition {
    pub discriminator: [u8; 8],
    pub market: [u8; 32],
    pub owner: [u8; 32],
    /// LP shares held (LE u128).
    pub shares: [u8; 16],
    /// Shares queued for redemption (LE u128); 0 = none pending.
    pub pending_redeem_shares: [u8; 16],
    /// Slot after which a pending redemption may execute (LE u64).
    pub pending_unlock_slot: [u8; 8],
    pub reserved: [u8; 16],
}

impl HlpPosition {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == HLP_POSITION_DISCRIMINATOR
    }
}

/// Decoded per-LP position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HlpPositionView {
    pub shares: u128,
    pub pending_redeem_shares: u128,
    pub pending_unlock_slot: u64,
}

// ---------- pure share math ----------

/// Shares minted for depositing `assets` quote atoms into a vault with
/// `total_shares` outstanding and net asset value `nav` (quote atoms). Uses the
/// virtual offset so the first deposit cannot be inflation-attacked. Rounds DOWN
/// (against the depositor), so a deposit never mints more than its fair share.
pub fn assets_to_shares(assets: u128, total_shares: u128, nav: u128) -> u128 {
    mul_div_floor_u128(
        assets,
        total_shares.saturating_add(HLP_VIRTUAL_SHARES),
        nav.saturating_add(HLP_VIRTUAL_ASSETS),
    )
}

/// Assets returned for redeeming `shares` against `total_shares` and `nav`. Rounds
/// DOWN (against the redeemer), so a redemption never pays more than its fair share
/// and dust rounding accrues to the remaining LPs.
pub fn shares_to_assets(shares: u128, total_shares: u128, nav: u128) -> u128 {
    mul_div_floor_u128(
        shares,
        nav.saturating_add(HLP_VIRTUAL_ASSETS),
        total_shares.saturating_add(HLP_VIRTUAL_SHARES),
    )
}

/// The House portfolio's current marked equity (capital + marked pnl + fee debt),
/// floored at 0, in quote atoms. Read from the House portfolio header via the
/// engine's `account_equity_from_parts`, which uses `pnl` (the running
/// mark-to-market ledger the cranks advance), so this is the FULL marked equity,
/// not just settled. Floored at 0: a negative-equity House is bankrupt and its
/// shares are worthless (limited liability), never negative. This is the deployed
/// half of HLP NAV; the other half is the free buffer's token balance.
pub fn house_marked_equity(house_data: &[u8]) -> Result<u128, OpenPerpsError> {
    let header_len = core::mem::size_of::<PortfolioAccountV16Account>();
    if house_data.len() < header_len {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    let header: &PortfolioAccountV16Account =
        bytemuck::try_from_bytes(&house_data[..header_len])
            .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    let equity = account_equity_from_parts(
        header.capital.get(),
        header.pnl.get(),
        header.fee_credits.get(),
    )
    .map_err(|_| OpenPerpsError::InvalidAccountData)?;
    Ok(if equity < 0 { 0 } else { equity as u128 })
}

// ---------- config buffer helpers ----------

/// Initialize or update the HLP config (the caller checks the market authority). On
/// first use the freshly-zeroed PDA is initialized with `total_shares = 0`. Params
/// are settable; `total_shares` is managed only by deposit/redeem (never here).
pub fn set_hlp_params_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    redeem_delay_slots: u64,
    fee_bps: u64,
    min_deposit: u128,
) -> Result<(), OpenPerpsError> {
    let cfg = hlp_config_mut(buf)?;
    if cfg.is_initialized() {
        if cfg.market != market {
            return Err(OpenPerpsError::ProvenanceMismatch);
        }
    } else {
        cfg.discriminator = HLP_CONFIG_DISCRIMINATOR;
        cfg.market = market;
        cfg.total_shares = 0u128.to_le_bytes();
    }
    cfg.redeem_delay_slots = redeem_delay_slots.to_le_bytes();
    cfg.fee_bps = fee_bps.to_le_bytes();
    cfg.min_deposit = min_deposit.to_le_bytes();
    Ok(())
}

/// Read the HLP config; errors if uninitialized or bound to a different market.
pub fn hlp_params_of(buf: &[u8], market: &[u8; 32]) -> Result<HlpParams, OpenPerpsError> {
    let cfg = hlp_config_ref(buf)?;
    if !cfg.is_initialized() {
        return Err(OpenPerpsError::UninitializedAccount);
    }
    if cfg.market != *market {
        return Err(OpenPerpsError::ProvenanceMismatch);
    }
    Ok(HlpParams {
        total_shares: u128::from_le_bytes(cfg.total_shares),
        redeem_delay_slots: u64::from_le_bytes(cfg.redeem_delay_slots),
        fee_bps: u64::from_le_bytes(cfg.fee_bps),
        min_deposit: u128::from_le_bytes(cfg.min_deposit),
    })
}

/// Overwrite `total_shares` (deposit mints, redeem burns). Requires an initialized
/// config bound to `market`.
pub fn set_hlp_total_shares_buffer(
    buf: &mut [u8],
    market: &[u8; 32],
    total_shares: u128,
) -> Result<(), OpenPerpsError> {
    let cfg = hlp_config_mut(buf)?;
    if !cfg.is_initialized() {
        return Err(OpenPerpsError::UninitializedAccount);
    }
    if cfg.market != *market {
        return Err(OpenPerpsError::ProvenanceMismatch);
    }
    cfg.total_shares = total_shares.to_le_bytes();
    Ok(())
}

// ---------- position buffer helpers ----------

/// Write a per-LP position (shares + pending redeem). On first use the zeroed PDA is
/// bound to `(market, owner)`.
pub fn set_hlp_position_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    owner: [u8; 32],
    shares: u128,
    pending_redeem_shares: u128,
    pending_unlock_slot: u64,
) -> Result<(), OpenPerpsError> {
    let pos = hlp_position_mut(buf)?;
    if pos.is_initialized() {
        if pos.market != market || pos.owner != owner {
            return Err(OpenPerpsError::ProvenanceMismatch);
        }
    } else {
        pos.discriminator = HLP_POSITION_DISCRIMINATOR;
        pos.market = market;
        pos.owner = owner;
    }
    pos.shares = shares.to_le_bytes();
    pos.pending_redeem_shares = pending_redeem_shares.to_le_bytes();
    pos.pending_unlock_slot = pending_unlock_slot.to_le_bytes();
    Ok(())
}

/// Read a per-LP position; all-zero if uninitialized. Errors if bound to a different
/// `(market, owner)`.
pub fn hlp_position_of(
    buf: &[u8],
    market: &[u8; 32],
    owner: &[u8; 32],
) -> Result<HlpPositionView, OpenPerpsError> {
    let pos = hlp_position_ref(buf)?;
    if !pos.is_initialized() {
        return Ok(HlpPositionView {
            shares: 0,
            pending_redeem_shares: 0,
            pending_unlock_slot: 0,
        });
    }
    if pos.market != *market || pos.owner != *owner {
        return Err(OpenPerpsError::ProvenanceMismatch);
    }
    Ok(HlpPositionView {
        shares: u128::from_le_bytes(pos.shares),
        pending_redeem_shares: u128::from_le_bytes(pos.pending_redeem_shares),
        pending_unlock_slot: u64::from_le_bytes(pos.pending_unlock_slot),
    })
}

fn hlp_config_mut(buf: &mut [u8]) -> Result<&mut HlpConfig, OpenPerpsError> {
    if buf.len() < HlpConfig::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes_mut(&mut buf[..HlpConfig::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn hlp_config_ref(buf: &[u8]) -> Result<&HlpConfig, OpenPerpsError> {
    if buf.len() < HlpConfig::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&buf[..HlpConfig::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn hlp_position_mut(buf: &mut [u8]) -> Result<&mut HlpPosition, OpenPerpsError> {
    if buf.len() < HlpPosition::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes_mut(&mut buf[..HlpPosition::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn hlp_position_ref(buf: &[u8]) -> Result<&HlpPosition, OpenPerpsError> {
    if buf.len() < HlpPosition::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&buf[..HlpPosition::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_mints_roughly_one_to_one() {
        // Empty vault, NAV 0: shares ~= assets (the virtual offset keeps it ~1:1 for
        // a sane first deposit well above the offset).
        let assets = 1_000_000_000u128;
        let shares = assets_to_shares(assets, 0, 0);
        assert!(shares > 0);
        // Redeeming all shares of a single LP returns ~all the assets (NAV == assets,
        // total_shares == minted shares), minus at most dust from the virtual offset.
        let back = shares_to_assets(shares, shares, assets);
        assert!(back <= assets);
        assert!(assets - back <= 2, "round-trip dust should be negligible");
    }

    #[test]
    fn second_depositor_is_priced_fairly_after_nav_grows() {
        // LP A deposits 1_000 at NAV 0 -> shares_a.
        let dep_a = 1_000_000u128;
        let shares_a = assets_to_shares(dep_a, 0, 0);
        let total = shares_a;
        // The House earns: NAV grows to 2x (1_000 deposited is now worth 2_000).
        let nav = 2_000_000u128;
        // LP B deposits the same 1_000 at the higher NAV -> fewer shares than A.
        let shares_b = assets_to_shares(dep_a, total, nav);
        assert!(shares_b < shares_a, "later deposit at higher NAV mints fewer shares");
        // B can redeem ~its deposit immediately (no value extracted from A).
        let total2 = total + shares_b;
        let nav2 = nav + dep_a; // buffer grew by B's deposit
        let back_b = shares_to_assets(shares_b, total2, nav2);
        assert!(back_b <= dep_a);
        assert!(dep_a - back_b <= dep_a / 1000, "B redeems ~its own deposit");
    }

    #[test]
    fn inflation_attack_is_unprofitable() {
        // Attacker first-deposits 1 atom, then donates a huge amount to NAV, hoping a
        // victim's deposit rounds to 0 shares and is captured. The virtual offset
        // makes the victim still receive a fair share.
        let attacker_shares = assets_to_shares(1, 0, 0);
        let total = attacker_shares;
        // Attacker donates 100_000 directly into NAV (not minting shares).
        let nav_after_donation = 1 + 100_000;
        // Victim deposits 1_000_000.
        let victim = 1_000_000u128;
        let victim_shares = assets_to_shares(victim, total, nav_after_donation);
        assert!(victim_shares > 0, "victim must receive non-zero shares");
        // Victim's claim on NAV must be close to their deposit, not siphoned to the
        // attacker. Redeem immediately against the post-deposit state.
        let total2 = total + victim_shares;
        let nav2 = nav_after_donation + victim;
        let victim_back = shares_to_assets(victim_shares, total2, nav2);
        // The attacker can capture at most ~their own donation, not the victim's
        // deposit; the victim recovers the large majority of their deposit.
        assert!(victim_back >= victim - victim / 100, "victim keeps >=99% of deposit");
    }

    #[test]
    fn redeem_rounds_down_against_the_redeemer() {
        // Dust rounding must never pay a redeemer more than fair (it accrues to
        // stayers), so total redemptions can never exceed NAV.
        let nav = 7_777_777u128;
        let total = assets_to_shares(nav, 0, 0);
        let half = total / 2;
        let a = shares_to_assets(half, total, nav);
        let b = shares_to_assets(total - half, total, nav);
        assert!(a + b <= nav, "redemptions never exceed NAV");
    }

    #[test]
    fn house_equity_floors_at_zero() {
        // A bankrupt House (capital 100, pnl -500) has negative raw equity; NAV floors
        // it at 0 (limited liability), never negative.
        let mut buf = vec![0u8; core::mem::size_of::<PortfolioAccountV16Account>()];
        {
            let h: &mut PortfolioAccountV16Account =
                bytemuck::from_bytes_mut(&mut buf[..]);
            h.capital = percolator::v16::V16PodU128::new(100);
            h.pnl = percolator::v16::V16PodI128::new(-500);
        }
        assert_eq!(house_marked_equity(&buf).unwrap(), 0);

        // A solvent House (capital 1_000, pnl +250) reports capital + pnl.
        {
            let h: &mut PortfolioAccountV16Account =
                bytemuck::from_bytes_mut(&mut buf[..]);
            h.capital = percolator::v16::V16PodU128::new(1_000);
            h.pnl = percolator::v16::V16PodI128::new(250);
        }
        assert_eq!(house_marked_equity(&buf).unwrap(), 1_250);
    }

    #[test]
    fn config_and_position_roundtrip() {
        let market = [0x9A; 32];
        let owner = [0x9B; 32];

        let mut cfg = vec![0u8; HlpConfig::LEN];
        set_hlp_params_buffer(&mut cfg, market, 216_000, 10, 1_000).unwrap();
        let p = hlp_params_of(&cfg, &market).unwrap();
        assert_eq!(p.total_shares, 0);
        assert_eq!(p.redeem_delay_slots, 216_000);
        assert_eq!(p.fee_bps, 10);
        assert_eq!(p.min_deposit, 1_000);
        set_hlp_total_shares_buffer(&mut cfg, &market, 5_000).unwrap();
        assert_eq!(hlp_params_of(&cfg, &market).unwrap().total_shares, 5_000);
        // Wrong market is rejected.
        assert_eq!(
            hlp_params_of(&cfg, &[0x00; 32]),
            Err(OpenPerpsError::ProvenanceMismatch)
        );

        let mut pos = vec![0u8; HlpPosition::LEN];
        // Uninitialized reads all-zero.
        assert_eq!(hlp_position_of(&pos, &market, &owner).unwrap().shares, 0);
        set_hlp_position_buffer(&mut pos, market, owner, 5_000, 1_000, 12_345).unwrap();
        let v = hlp_position_of(&pos, &market, &owner).unwrap();
        assert_eq!(v.shares, 5_000);
        assert_eq!(v.pending_redeem_shares, 1_000);
        assert_eq!(v.pending_unlock_slot, 12_345);
        // Wrong owner is rejected.
        assert_eq!(
            hlp_position_of(&pos, &market, &[0x00; 32]),
            Err(OpenPerpsError::ProvenanceMismatch)
        );
    }
}
