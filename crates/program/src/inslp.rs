//! Insurance LP (InsLP): a permissionless, tokenized claim on a market's insurance
//! fund, parallel to (but distinct from) HLP.
//!
//! HLP backs the House counterparty portfolio: first-loss, directional, earns the
//! spread + funding. InsLP backs the engine's insurance `I`: second-loss, only
//! drawn on bankruptcies after the House and liquidation cannot cover, earns the
//! fee inflow routed to insurance. Two risk tiers, one for each appetite.
//!
//! Like HLP, this is a wrapper construct over engine state and does NOT modify the
//! vendored engine: it adds share accounting on top of the engine's per-(asset,
//! side) domain insurance, funding / withdrawing the canonical domain
//! ([`INSLP_CANONICAL_DOMAIN`]). Capital lives in the existing market vault (as
//! engine `I`), so there is no separate buffer. NAV is the engine's total insurance
//! `I`; shares are priced with the same virtual-offset math HLP uses (proven in
//! `hlp.rs`). The deposit / redeem handlers live in `processor.rs`.
//!
//! v1 (Cach A) funds and withdraws the canonical domain only, with NAV = total `I`.
//! The virtual-share offset means LP shares claim ~their own deposit, never the
//! authority-seeded floor in other domains. The redeem is bounded by the canonical
//! domain's engine budget, so on a multi-domain market a redemption can be
//! temporarily blocked if that domain is drawn down even when total `I` is healthy
//! (it never loses funds or breaks solvency; it waits). See docs/inslp.md.

use bytemuck::{Pod, Zeroable};

use crate::error::OpenPerpsError;

/// PDA seed for the InsLP config: `[INSLP_SEED, market]`. Holds `total_shares` and
/// the withdrawal governance (delay, fee, min deposit).
pub const INSLP_SEED: &[u8] = b"inslp";
/// PDA seed for a per-LP InsLP position: `[INSLP_POSITION_SEED, market, owner]`.
pub const INSLP_POSITION_SEED: &[u8] = b"inslppos";

/// Magic bytes for an [`InsLpConfig`].
pub const INSLP_CONFIG_DISCRIMINATOR: [u8; 8] = *b"OPINSLPC";
/// Magic bytes for an [`InsLpPosition`].
pub const INSLP_POSITION_DISCRIMINATOR: [u8; 8] = *b"OPINSLPP";

/// The (asset, side) insurance domain InsLP v1 funds and withdraws:
/// `insurance_domain_index(asset_index = 0, side = 0) = 0` (asset 0, long).
pub const INSLP_CANONICAL_DOMAIN: usize = 0;

/// Per-market InsLP config. Byte arrays keep it alignment-1 and padding-free (Pod).
/// Mirrors [`crate::hlp::HlpConfig`] minus the NAV haircut: insurance `I` is settled
/// quote capital, not marked PnL, so there are no paper gains to discount.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct InsLpConfig {
    pub discriminator: [u8; 8],
    pub market: [u8; 32],
    /// Total LP shares outstanding (LE u128).
    pub total_shares: [u8; 16],
    /// Redemption timelock: slots between request and execute (LE u64).
    pub redeem_delay_slots: [u8; 8],
    /// Deposit + redeem fee in bps, kept in `I` (anti round-trip) (LE u64).
    pub fee_bps: [u8; 8],
    /// Minimum first/each deposit in quote atoms (anti dust / inflation) (LE u128).
    pub min_deposit: [u8; 16],
    pub reserved: [u8; 24],
}

impl InsLpConfig {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == INSLP_CONFIG_DISCRIMINATOR
    }
}

/// Decoded InsLP config.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InsLpParams {
    pub total_shares: u128,
    pub redeem_delay_slots: u64,
    pub fee_bps: u64,
    pub min_deposit: u128,
}

/// Per-LP InsLP position: share balance + the single pending-redeem slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct InsLpPosition {
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

impl InsLpPosition {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub fn is_initialized(&self) -> bool {
        self.discriminator == INSLP_POSITION_DISCRIMINATOR
    }
}

/// Decoded per-LP position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InsLpPositionView {
    pub shares: u128,
    pub pending_redeem_shares: u128,
    pub pending_unlock_slot: u64,
}

// ---------- config buffer helpers ----------

/// Initialize or update the InsLP config (the caller checks the market authority).
/// On first use the freshly-zeroed PDA is initialized with `total_shares = 0`.
/// `total_shares` is managed only by deposit/redeem (never here).
pub fn set_inslp_params_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    redeem_delay_slots: u64,
    fee_bps: u64,
    min_deposit: u128,
) -> Result<(), OpenPerpsError> {
    let cfg = inslp_config_mut(buf)?;
    if cfg.is_initialized() {
        if cfg.market != market {
            return Err(OpenPerpsError::ProvenanceMismatch);
        }
    } else {
        cfg.discriminator = INSLP_CONFIG_DISCRIMINATOR;
        cfg.market = market;
        cfg.total_shares = 0u128.to_le_bytes();
    }
    cfg.redeem_delay_slots = redeem_delay_slots.to_le_bytes();
    cfg.fee_bps = fee_bps.to_le_bytes();
    cfg.min_deposit = min_deposit.to_le_bytes();
    Ok(())
}

/// Read the InsLP config; errors if uninitialized or bound to a different market.
pub fn inslp_params_of(buf: &[u8], market: &[u8; 32]) -> Result<InsLpParams, OpenPerpsError> {
    let cfg = inslp_config_ref(buf)?;
    if !cfg.is_initialized() {
        return Err(OpenPerpsError::UninitializedAccount);
    }
    if cfg.market != *market {
        return Err(OpenPerpsError::ProvenanceMismatch);
    }
    Ok(InsLpParams {
        total_shares: u128::from_le_bytes(cfg.total_shares),
        redeem_delay_slots: u64::from_le_bytes(cfg.redeem_delay_slots),
        fee_bps: u64::from_le_bytes(cfg.fee_bps),
        min_deposit: u128::from_le_bytes(cfg.min_deposit),
    })
}

/// Overwrite `total_shares` (deposit mints, redeem burns). Requires an initialized
/// config bound to `market`.
pub fn set_inslp_total_shares_buffer(
    buf: &mut [u8],
    market: &[u8; 32],
    total_shares: u128,
) -> Result<(), OpenPerpsError> {
    let cfg = inslp_config_mut(buf)?;
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
pub fn set_inslp_position_buffer(
    buf: &mut [u8],
    market: [u8; 32],
    owner: [u8; 32],
    shares: u128,
    pending_redeem_shares: u128,
    pending_unlock_slot: u64,
) -> Result<(), OpenPerpsError> {
    let pos = inslp_position_mut(buf)?;
    if pos.is_initialized() {
        if pos.market != market || pos.owner != owner {
            return Err(OpenPerpsError::ProvenanceMismatch);
        }
    } else {
        pos.discriminator = INSLP_POSITION_DISCRIMINATOR;
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
pub fn inslp_position_of(
    buf: &[u8],
    market: &[u8; 32],
    owner: &[u8; 32],
) -> Result<InsLpPositionView, OpenPerpsError> {
    let pos = inslp_position_ref(buf)?;
    if !pos.is_initialized() {
        return Ok(InsLpPositionView {
            shares: 0,
            pending_redeem_shares: 0,
            pending_unlock_slot: 0,
        });
    }
    if pos.market != *market || pos.owner != *owner {
        return Err(OpenPerpsError::ProvenanceMismatch);
    }
    Ok(InsLpPositionView {
        shares: u128::from_le_bytes(pos.shares),
        pending_redeem_shares: u128::from_le_bytes(pos.pending_redeem_shares),
        pending_unlock_slot: u64::from_le_bytes(pos.pending_unlock_slot),
    })
}

fn inslp_config_mut(buf: &mut [u8]) -> Result<&mut InsLpConfig, OpenPerpsError> {
    if buf.len() < InsLpConfig::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes_mut(&mut buf[..InsLpConfig::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn inslp_config_ref(buf: &[u8]) -> Result<&InsLpConfig, OpenPerpsError> {
    if buf.len() < InsLpConfig::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&buf[..InsLpConfig::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn inslp_position_mut(buf: &mut [u8]) -> Result<&mut InsLpPosition, OpenPerpsError> {
    if buf.len() < InsLpPosition::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes_mut(&mut buf[..InsLpPosition::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

fn inslp_position_ref(buf: &[u8]) -> Result<&InsLpPosition, OpenPerpsError> {
    if buf.len() < InsLpPosition::LEN {
        return Err(OpenPerpsError::AccountDataTooSmall);
    }
    bytemuck::try_from_bytes(&buf[..InsLpPosition::LEN])
        .map_err(|_| OpenPerpsError::InvalidAccountData)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip() {
        let market = [0x3C; 32];
        let mut cfg = vec![0u8; InsLpConfig::LEN];
        // Uninitialized read errors.
        assert_eq!(
            inslp_params_of(&cfg, &market),
            Err(OpenPerpsError::UninitializedAccount)
        );
        set_inslp_params_buffer(&mut cfg, market, 216_000, 10, 1_000).unwrap();
        let p = inslp_params_of(&cfg, &market).unwrap();
        assert_eq!(p.total_shares, 0);
        assert_eq!(p.redeem_delay_slots, 216_000);
        assert_eq!(p.fee_bps, 10);
        assert_eq!(p.min_deposit, 1_000);
        set_inslp_total_shares_buffer(&mut cfg, &market, 7_000).unwrap();
        assert_eq!(inslp_params_of(&cfg, &market).unwrap().total_shares, 7_000);
        // Wrong market rejected.
        assert_eq!(
            inslp_params_of(&cfg, &[0x00; 32]),
            Err(OpenPerpsError::ProvenanceMismatch)
        );
    }

    #[test]
    fn position_roundtrip() {
        let market = [0x3C; 32];
        let owner = [0x3D; 32];
        let mut pos = vec![0u8; InsLpPosition::LEN];
        // Uninitialized reads all-zero.
        assert_eq!(inslp_position_of(&pos, &market, &owner).unwrap().shares, 0);
        set_inslp_position_buffer(&mut pos, market, owner, 4_000, 500, 9_999).unwrap();
        let v = inslp_position_of(&pos, &market, &owner).unwrap();
        assert_eq!(v.shares, 4_000);
        assert_eq!(v.pending_redeem_shares, 500);
        assert_eq!(v.pending_unlock_slot, 9_999);
        // Wrong owner rejected.
        assert_eq!(
            inslp_position_of(&pos, &market, &[0x00; 32]),
            Err(OpenPerpsError::ProvenanceMismatch)
        );
    }
}
