//! Pyth pull-oracle (`PriceUpdateV2`) account parsing for `oracle_kind = PYTH`.
//!
//! Byte layout validated against the live Solana devnet SOL/USD sponsored feed
//! account (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`), owned by the Pyth
//! receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`:
//!
//! ```text
//!   [0..8]    Anchor discriminator (PriceUpdateV2)
//!   [8..40]   write_authority (Pubkey)
//!   [40]      verification_level: 1 = Full, 0 = Partial{num_signatures: u8}
//!   price_message (starts at 41 when Full):
//!     [+0..32]  feed_id        [u8; 32]
//!     [+32..40] price          i64 LE
//!     [+40..48] conf           u64 LE
//!     [+48..52] exponent       i32 LE
//!     [+52..60] publish_time   i64 LE  (unix seconds)
//!     [+60..68] prev_publish   i64 LE
//!     [+68..76] ema_price      i64 LE
//!     [+76..84] ema_conf       u64 LE
//!   [125..133] posted_slot     u64 LE  (Solana slot; Full layout)
//!   len 134 (one trailing alloc-padding byte)
//! ```
//!
//! This module only parses and validates the bytes. The caller verifies the
//! account owner is the receiver program, supplies the expected feed id, and
//! enforces freshness against the on-chain Clock. Partial verification is
//! rejected: only a Full (complete Wormhole guardian quorum) update is trusted.

/// The Pyth receiver program that must own a `PriceUpdateV2` account. Same
/// address on devnet and mainnet-beta.
pub const PYTH_RECEIVER: [u8; 32] = [
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116,
    250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
];

/// Anchor account discriminator for `PriceUpdateV2`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

const VERIFICATION_FULL: u8 = 1;
const PM_START_FULL: usize = 41;
/// Full-verified `PriceUpdateV2` allocation length (price_message at 41).
const FULL_LEN: usize = 134;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PythError {
    TooSmall,
    BadDiscriminator,
    NotFullyVerified,
    FeedMismatch,
    NonPositivePrice,
    Overflow,
}

/// The fields a price crank needs from a `PriceUpdateV2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub price: i64,
    /// Confidence interval (same scale as `price`); a wider band is a less
    /// certain price.
    pub conf: u64,
    /// Pyth's exponentially-weighted moving average price (same scale as
    /// `price`); a smoothed reference the spot should not diverge far from.
    pub ema_price: i64,
    pub expo: i32,
    /// Unix seconds the price was published on Pythnet.
    pub publish_time: i64,
    /// Solana slot the update was posted on this cluster.
    pub posted_slot: u64,
}

fn rd_i64(b: &[u8], o: usize) -> Result<i64, PythError> {
    b.get(o..o + 8)
        .and_then(|s| s.try_into().ok())
        .map(i64::from_le_bytes)
        .ok_or(PythError::TooSmall)
}

fn rd_u64(b: &[u8], o: usize) -> Result<u64, PythError> {
    b.get(o..o + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(PythError::TooSmall)
}

fn rd_i32(b: &[u8], o: usize) -> Result<i32, PythError> {
    b.get(o..o + 4)
        .and_then(|s| s.try_into().ok())
        .map(i32::from_le_bytes)
        .ok_or(PythError::TooSmall)
}

/// Parse and validate a Full-verified `PriceUpdateV2` account body, binding it
/// to `expected_feed_id`. Does not check the account owner or freshness; the
/// caller does both.
pub fn parse_price_update_v2(
    data: &[u8],
    expected_feed_id: &[u8; 32],
) -> Result<PythPrice, PythError> {
    if data.len() < FULL_LEN {
        return Err(PythError::TooSmall);
    }
    if data[0..8] != PRICE_UPDATE_V2_DISCRIMINATOR {
        return Err(PythError::BadDiscriminator);
    }
    // Require Full verification so price_message sits at a fixed offset and the
    // update carries a complete guardian quorum.
    if data[40] != VERIFICATION_FULL {
        return Err(PythError::NotFullyVerified);
    }
    let pm = PM_START_FULL;
    if &data[pm..pm + 32] != expected_feed_id.as_slice() {
        return Err(PythError::FeedMismatch);
    }
    let price = rd_i64(data, pm + 32)?;
    let conf = rd_u64(data, pm + 40)?;
    let expo = rd_i32(data, pm + 48)?;
    let publish_time = rd_i64(data, pm + 52)?;
    let ema_price = rd_i64(data, pm + 68)?;
    let posted_slot = rd_u64(data, pm + 84)?;
    if price <= 0 {
        return Err(PythError::NonPositivePrice);
    }
    Ok(PythPrice {
        price,
        conf,
        ema_price,
        expo,
        publish_time,
        posted_slot,
    })
}

/// True if the price's confidence interval is within `max_bps` of the price
/// (`conf / price <= max_bps / 10_000`). A wide band means a less certain price
/// that a settlement crank should reject. A non-positive price is never ok.
pub fn confidence_ok(price: i64, conf: u64, max_bps: u64) -> bool {
    if price <= 0 {
        return false;
    }
    (conf as u128) * 10_000 <= (price as u128) * (max_bps as u128)
}

/// True if the spot `price` is within `max_bps` of the `ema_price`
/// (`|price - ema| / ema <= max_bps / 10_000`). A large gap is a single-tick
/// spike or glitch that has not propagated to the smoothed EMA, which a
/// settlement crank should reject. A non-positive price or ema is never ok.
pub fn ema_divergence_ok(price: i64, ema_price: i64, max_bps: u64) -> bool {
    if price <= 0 || ema_price <= 0 {
        return false;
    }
    let diff = (price - ema_price).unsigned_abs() as u128;
    diff * 10_000 <= (ema_price as u128) * (max_bps as u128)
}

/// Convert a Pyth `(price, expo)` to the OpenPerps mark scale: quote atoms per
/// 1.0 base, `quote_decimals` places. `mark = price * 10^(quote_decimals + expo)`.
/// Truncates when scaling down. Errors on non-positive price or overflow.
pub fn price_to_mark(price: i64, expo: i32, quote_decimals: u32) -> Result<u64, PythError> {
    if price <= 0 {
        return Err(PythError::NonPositivePrice);
    }
    let p = price as u128;
    let e = expo as i64 + quote_decimals as i64;
    let v = if e >= 0 {
        let f = 10u128.checked_pow(e as u32).ok_or(PythError::Overflow)?;
        p.checked_mul(f).ok_or(PythError::Overflow)?
    } else {
        let f = 10u128.checked_pow((-e) as u32).ok_or(PythError::Overflow)?;
        p / f
    };
    u64::try_from(v).map_err(|_| PythError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real Full-verified SOL/USD `PriceUpdateV2` snapshot pulled from devnet
    // account 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE on 2026-06-03.
    const HEX: &str = "22f123639d7ef4cd60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b24301ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d9a777dc101000000e763860000000000f8ffffff8c03206a000000008b03206a00000000b4a64dbf01000000b3277d00000000001887d31b0000000000";
    const SOL_USD_FEED: &str =
        "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

    fn hx(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn feed() -> [u8; 32] {
        let v = hx(SOL_USD_FEED);
        let mut a = [0u8; 32];
        a.copy_from_slice(&v);
        a
    }

    #[test]
    fn parses_real_devnet_sol_usd() {
        let d = hx(HEX);
        assert_eq!(d.len(), FULL_LEN);
        let p = parse_price_update_v2(&d, &feed()).unwrap();
        assert_eq!(p.price, 7_541_192_602);
        assert_eq!(p.conf, 8_807_399);
        assert_eq!(p.ema_price, 7_504_504_500);
        assert_eq!(p.expo, -8);
        assert_eq!(p.publish_time, 1_780_482_956);
        assert_eq!(p.posted_slot, 466_847_512);
        // $75.41192602 -> 6-decimal quote mark = 75_411_926 atoms.
        assert_eq!(price_to_mark(p.price, p.expo, 6).unwrap(), 75_411_926);
        // The live SOL/USD band is ~11.7 bps, well inside a 2% gate.
        assert!(confidence_ok(p.price, p.conf, 200));
        // The live spot/EMA gap is ~48 bps, well inside a 10% gate.
        assert!(ema_divergence_ok(p.price, p.ema_price, 1_000));
    }

    #[test]
    fn confidence_gate() {
        // conf/price = 1% passes a 2% gate, fails a 0.5% gate.
        assert!(confidence_ok(10_000, 100, 200));
        assert!(!confidence_ok(10_000, 100, 50));
        // exactly at the threshold is ok.
        assert!(confidence_ok(10_000, 100, 100));
        // non-positive price is never ok.
        assert!(!confidence_ok(0, 0, 200));
    }

    #[test]
    fn ema_divergence_gate() {
        // No gap passes; symmetric gaps measured against the ema.
        assert!(ema_divergence_ok(10_000, 10_000, 1_000));
        // +10% is exactly at a 10% gate; +20% is over it.
        assert!(ema_divergence_ok(11_000, 10_000, 1_000));
        assert!(!ema_divergence_ok(12_000, 10_000, 1_000));
        // A downward spike is caught too.
        assert!(!ema_divergence_ok(8_000, 10_000, 1_000));
        // non-positive price or ema is never ok.
        assert!(!ema_divergence_ok(0, 10_000, 1_000));
        assert!(!ema_divergence_ok(10_000, 0, 1_000));
    }

    #[test]
    fn price_to_mark_scales_both_directions() {
        // expo + quote_decimals >= 0 multiplies.
        assert_eq!(price_to_mark(5, 0, 6).unwrap(), 5_000_000);
        // expo + quote_decimals < 0 divides (truncates).
        assert_eq!(price_to_mark(12_345, -3, 0).unwrap(), 12);
        assert_eq!(price_to_mark(-1, -8, 6), Err(PythError::NonPositivePrice));
    }

    #[test]
    fn rejects_wrong_feed() {
        let d = hx(HEX);
        let mut f = feed();
        f[0] ^= 1;
        assert_eq!(parse_price_update_v2(&d, &f), Err(PythError::FeedMismatch));
    }

    #[test]
    fn rejects_bad_discriminator() {
        let mut d = hx(HEX);
        d[0] ^= 1;
        assert_eq!(
            parse_price_update_v2(&d, &feed()),
            Err(PythError::BadDiscriminator)
        );
    }

    #[test]
    fn rejects_partial_verification() {
        let mut d = hx(HEX);
        d[40] = 0; // Partial
        assert_eq!(
            parse_price_update_v2(&d, &feed()),
            Err(PythError::NotFullyVerified)
        );
    }

    #[test]
    fn rejects_truncated() {
        let d = hx(HEX);
        assert_eq!(
            parse_price_update_v2(&d[..120], &feed()),
            Err(PythError::TooSmall)
        );
    }
}
