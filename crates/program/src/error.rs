//! Program-specific errors, mapped to `ProgramError::Custom(code)`.

use percolator::v16::V16Error;
use pinocchio::program_error::ProgramError;

/// OpenPerps program errors. The discriminant is the `Custom` code returned
/// on-chain, so existing variants must keep their numbers stable.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenPerpsError {
    /// Instruction tag byte did not match any known instruction.
    InvalidInstruction = 0,
    /// Instruction payload was malformed or too short.
    InvalidInstructionData = 1,
    /// Target account was already initialized.
    AccountAlreadyInitialized = 2,
    /// Target account was expected to be initialized but was not.
    UninitializedAccount = 3,
    /// Account is not owned by this program.
    InvalidAccountOwner = 4,
    /// A required signer did not sign.
    MissingRequiredSignature = 5,
    /// Account data layout/discriminator was invalid.
    InvalidAccountData = 6,
    /// Account data buffer is smaller than the required layout.
    AccountDataTooSmall = 7,
    /// A checked arithmetic operation overflowed.
    ArithmeticOverflow = 8,
    /// Caller passed an account whose provenance does not match the market.
    ProvenanceMismatch = 9,
    /// Deposit would push a memecoin (DEX-priced) account's collateral past the
    /// per-portfolio cap that bounds manipulation exposure.
    DepositCapExceeded = 10,
    /// A Pyth price update was malformed, bound to the wrong feed, not fully
    /// verified, or too stale to crank the mark from.
    StalePythPrice = 11,
    /// A DEX pool's quote-side depth is below the per-market floor, so it cannot
    /// price the market (or a vault/account was malformed).
    PoolTooThin = 12,
    /// The trading delegate (session key) is past its expiry slot. The owner
    /// must issue a fresh `SetDelegate` to keep trading on the session key.
    DelegateExpired = 13,
    /// A trade would push the House's net position in the asset past the market's
    /// configured House exposure cap (`SetHouseCap`).
    HouseExposureCapExceeded = 14,
    /// A `SetInsuranceParams` tried to LOWER the insurance fund's withdrawal floor
    /// or shorten its withdrawal timelock. Both are raise-only (a ratchet), so the
    /// fund's guarantees can only strengthen.
    InsuranceParamLoosened = 15,
    /// An insurance withdrawal would pull the fund below its configured floor
    /// (`min_balance`), or no balance is available above the floor.
    InsuranceFloorBreach = 16,
    /// An insurance withdrawal was executed before its timelock unlock slot, or
    /// requested with no funds available.
    InsuranceWithdrawLocked = 17,
    /// `ExecuteInsuranceWithdraw` ran with no pending withdrawal recorded (the
    /// authority must `RequestInsuranceWithdraw` first).
    InsuranceNoPending = 18,
    /// `SetRequireVerifiable` tried to turn the market's verifiable-oracle flag
    /// back OFF. The flag is a one-way ratchet (relayer -> verifiable only), so a
    /// market's pricing trust can only ever strengthen, never silently revert to a
    /// single relayer key.
    VerifiableCannotDowngrade = 19,
    /// An HLP deposit was below the configured `min_deposit`, or minted zero shares.
    HlpBelowMinDeposit = 20,
    /// An HLP redemption requested more shares than the LP holds.
    HlpInsufficientShares = 21,
    /// An HLP redemption exceeds the free buffer; it must wait for the buffer to
    /// refill (via deposits or a harvest) before it can be executed.
    HlpBufferInsufficient = 22,
    /// An HLP redemption was executed before its timelock, or with nothing pending.
    HlpRedeemLocked = 23,
    /// `WithdrawHouseVault` was attempted while the market's HLP vault has LP
    /// shares outstanding. Once LPs are in the House, the authority cannot drain
    /// it out from under them; harvest into the buffer and let LPs redeem instead.
    HlpLpClaimsOutstanding = 24,
}

impl From<OpenPerpsError> for ProgramError {
    fn from(e: OpenPerpsError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Offset added to every `V16Error` discriminant when surfacing it on-chain,
/// to keep engine errors disjoint from [`OpenPerpsError`] codes.
pub const V16_ERROR_BASE: u32 = 1000;

impl From<V16Error> for OpenPerpsError {
    fn from(_: V16Error) -> Self {
        // Concrete code is preserved via the ProgramError mapping below;
        // collapsing to a single variant here lets callers use `?` against
        // both error families without losing information at the program
        // boundary.
        OpenPerpsError::InvalidAccountData
    }
}

/// Map an engine `V16Error` directly to `ProgramError::Custom`, preserving the
/// engine variant in the code.
pub fn v16_to_program_error(e: V16Error) -> ProgramError {
    ProgramError::Custom(V16_ERROR_BASE + (e as u32))
}

/// Result extension to lift engine errors through `?` while keeping the engine
/// variant in the Custom code.
pub trait V16ResultExt<T> {
    fn map_v16(self) -> Result<T, ProgramError>;
}

impl<T> V16ResultExt<T> for Result<T, V16Error> {
    fn map_v16(self) -> Result<T, ProgramError> {
        self.map_err(v16_to_program_error)
    }
}
