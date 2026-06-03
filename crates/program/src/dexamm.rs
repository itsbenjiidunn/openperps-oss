//! Real constant-product AMM pricing for `DEX_EWMA` markets.
//!
//! The reader takes reserves from two standard SPL token vaults (the format
//! Raydium CPMM and other constant-product AMMs keep their reserves in) rather
//! than parsing a version-specific pool-state layout. Reading the stable SPL
//! `TokenAccount` `amount` field keeps the reader AMM-agnostic and validatable
//! against real accounts: a market authority pins whichever two vaults belong to
//! the chosen pool, and the crank reads their live balances.
//!
//! Manipulation resistance for a custom token comes from layering: the depth
//! floor here rejects a thin or drained pool, the engine's per-slot move bound
//! plus EWMA smooth a single-block balance push, and the per-portfolio collateral
//! cap bounds the profit. A program-side TWAP (the pure accumulator below, PDA
//! wiring deferred) is the next layer.

/// SPL `TokenAccount` `amount` field offset (u64 LE): mint(32) + owner(32).
const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DexError {
    TooSmall,
    EmptyReserve,
    PoolTooThin,
    Overflow,
}

/// Read an SPL `TokenAccount`'s balance in atoms. The caller verifies the
/// account is owned by the SPL Token program.
pub fn token_account_amount(data: &[u8]) -> Result<u64, DexError> {
    data.get(TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(DexError::TooSmall)
}

/// Spot price of 1.0 base in the 6-decimal quote (the OpenPerps mark scale), from
/// constant-product reserves: `reserve_quote * 10^base_decimals / reserve_base`.
/// Assumes the quote vault is the 6-decimal shared collateral (mUSDC), so quote
/// atoms already carry the mark scale. Errors on an empty base reserve or overflow.
pub fn cp_spot_to_mark(
    reserve_base: u64,
    reserve_quote: u64,
    base_decimals: u32,
) -> Result<u64, DexError> {
    if reserve_base == 0 {
        return Err(DexError::EmptyReserve);
    }
    let factor = 10u128.checked_pow(base_decimals).ok_or(DexError::Overflow)?;
    let price = (reserve_quote as u128)
        .checked_mul(factor)
        .ok_or(DexError::Overflow)?
        / reserve_base as u128;
    u64::try_from(price).map_err(|_| DexError::Overflow)
}

/// The quote-side reserve is the pool depth (half the TVL). Require it to meet a
/// per-market floor, so a drained or thin pool cannot price the market.
pub fn check_depth(reserve_quote: u64, min_quote_depth: u64) -> Result<(), DexError> {
    if reserve_quote < min_quote_depth {
        return Err(DexError::PoolTooThin);
    }
    Ok(())
}

// ---- TWAP accumulation (pure library; the `[TWAP_SEED, market, asset]` PDA
//      wiring is Part B step 3 in docs/oracle-integration.md, deferred) ----

/// Advance a cumulative-price accumulator by `last_price * dt_secs`, the
/// Uniswap-V2-style time-weighted accumulator. Saturating so a long gap cannot
/// panic; a consumer snapshots `(cumulative, ts)` and averages over a window.
pub fn twap_accumulate(cumulative: u128, last_price: u64, dt_secs: u64) -> u128 {
    cumulative.saturating_add((last_price as u128) * (dt_secs as u128))
}

/// Time-weighted average price over a window, from two cumulative snapshots:
/// `(cum_now - cum_then) / window_secs`. `None` on a zero window or underflow.
pub fn twap_average(cum_now: u128, cum_then: u128, window_secs: u64) -> Option<u64> {
    if window_secs == 0 {
        return None;
    }
    u64::try_from(cum_now.checked_sub(cum_then)? / window_secs as u128).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal SPL TokenAccount byte buffer with a given amount.
    fn token_acct(amount: u64) -> Vec<u8> {
        let mut v = vec![0u8; 165]; // full SPL TokenAccount length
        v[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
            .copy_from_slice(&amount.to_le_bytes());
        v
    }

    #[test]
    fn reads_token_amount() {
        assert_eq!(token_account_amount(&token_acct(123_456)).unwrap(), 123_456);
        assert_eq!(token_account_amount(&[0u8; 10]), Err(DexError::TooSmall));
    }

    #[test]
    fn cp_spot_matches_mock_when_base_is_6_decimals() {
        // base_decimals = 6 reproduces the mock formula reserve_quote * 1e6 / reserve_base.
        // Pool: 1000 base (9dp) and 75_000 mUSDC (6dp) -> $75.000000 -> 75_000_000.
        let rb = 1_000u64 * 1_000_000_000; // 1000 base @ 9dp
        let rq = 75_000u64 * 1_000_000; // 75,000 mUSDC @ 6dp
        assert_eq!(cp_spot_to_mark(rb, rq, 9).unwrap(), 75_000_000);
        // 6dp base behaves like the mock pool.
        assert_eq!(cp_spot_to_mark(2_000_000, 75 * 2_000_000, 6).unwrap(), 75_000_000);
        assert_eq!(cp_spot_to_mark(0, 1, 9), Err(DexError::EmptyReserve));
    }

    #[test]
    fn depth_floor() {
        assert!(check_depth(25_000_000_000, 25_000_000_000).is_ok());
        assert_eq!(
            check_depth(24_999_999_999, 25_000_000_000),
            Err(DexError::PoolTooThin)
        );
    }

    #[test]
    fn twap_accumulate_and_average() {
        // Price 100 held for 10s then 120 held for 10s -> average 110.
        let mut cum = 0u128;
        let c0 = cum;
        cum = twap_accumulate(cum, 100, 10);
        cum = twap_accumulate(cum, 120, 10);
        assert_eq!(twap_average(cum, c0, 20).unwrap(), 110);
        assert_eq!(twap_average(cum, c0, 0), None);
    }
}
