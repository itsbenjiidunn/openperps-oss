//! Instruction wire format.
//!
//! Layout is deliberately hand-rolled (no borsh) to stay `no_std` and
//! zero-allocation: the first byte is the tag, the remainder is the
//! little-endian payload. The TypeScript SDK mirrors this exactly.

use crate::error::OpenPerpsError;

/// Tag bytes for each instruction. The SDK and any future migration reference
/// these stable numbers.
pub mod tag {
    pub const INIT_MARKET: u8 = 0;
    pub const INIT_PORTFOLIO: u8 = 1;
    pub const DEPOSIT: u8 = 2;
    pub const ACTIVATE_MARKET: u8 = 3;
    pub const ACCRUE_ASSET: u8 = 4;
    pub const TRADE: u8 = 5;
    pub const CREATE_VAULT: u8 = 6;
    pub const WITHDRAW: u8 = 7;
    pub const LIQUIDATE: u8 = 8;
    pub const RESOLVE_MARKET: u8 = 9;
    pub const CRANK_REFRESH: u8 = 10;
    pub const CREATE_HOUSE_VAULT: u8 = 11;
    pub const FUND_HOUSE_VAULT: u8 = 12;
    pub const WITHDRAW_HOUSE_VAULT: u8 = 13;
    pub const PLACE_ORDER: u8 = 14;
    pub const CREATE_MOCK_POOL: u8 = 15;
    pub const MOCK_SWAP: u8 = 16;
    pub const CRANK_ORACLE: u8 = 17;
    pub const PIN_ORACLE_POOL: u8 = 18;
    pub const SET_DELEGATE: u8 = 19;
    pub const SETTLE_PNL: u8 = 20;
    pub const SET_ORACLE_AUTHORITY: u8 = 21;
    pub const SET_DEPOSIT_CAP: u8 = 22;
    pub const CRANK_PYTH: u8 = 23;
    pub const SET_DEX_POOL: u8 = 24;
    pub const CRANK_DEX_SPOT: u8 = 25;
}

/// Decoded OpenPerps instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenPerpsInstruction {
    /// Initialize a new market-group account.
    ///
    /// Accounts:
    ///   0. `[writable]` market account (uninitialized, owned by this program,
    ///      sized for the chosen `asset_slot_capacity`)
    ///   1. `[signer]`   authority that will own the market group
    ///   2. `[]`         quote_mint, the SPL mint accepted as collateral
    ///                    (just read for its pubkey; bound into the wrapper
    ///                    header. Vault token account is created by Phase B.)
    ///
    /// `vault_bump` is the bump returned by
    /// `find_program_address([VAULT_SEED, market.key()], program_id)`
    /// off-chain; the handler verifies it via `create_program_address`.
    ///
    /// `base_mint` is the underlying asset's SPL mint (all-zero for a
    /// synthetic like BTC/ETH). `oracle_kind` is 0 (manual), 1 (Pyth) or 2
    /// (DEX-EWMA). `oracle_feed_id` is the 32-byte Pyth feed id (all-zero
    /// otherwise) and `oracle_pool` is the DEX pool account read by
    /// `CrankOracle` (all-zero unless `oracle_kind == DEX_EWMA`). These make
    /// the market self-describing on-chain.
    InitMarket {
        market_group_id: [u8; 32],
        asset_slot_capacity: u32,
        vault_bump: u8,
        base_mint: [u8; 32],
        oracle_kind: u8,
        oracle_feed_id: [u8; 32],
        oracle_pool: [u8; 32],
    },
    /// Initialize a user's portfolio at the deterministic PDA
    /// `[PORTFOLIO_SEED, owner, market]`. The program creates the account itself
    /// (CPI to the System Program, signed by the PDA), so there is no client
    /// keypair and exactly one account per (owner, market), discoverable on any
    /// device by re-deriving the address. `bump` is the canonical PDA bump.
    ///
    /// Accounts:
    ///   0. `[writable]`         portfolio PDA (uninitialized)
    ///   1. `[]`                 market account (read for provenance)
    ///   2. `[signer, writable]` owner of the portfolio (pays rent)
    ///   3. `[]`                 system program
    InitPortfolio { bump: u8 },
    /// Transfer `amount` of the quote_mint from the owner's token account
    /// into the per-market vault TokenAccount, and credit the engine's
    /// portfolio capital + market vault by the same amount.
    ///
    /// `amount` is bounded to `u64::MAX` because SPL Token Transfer is u64;
    /// the engine `u128` field is wide enough to never overflow on aggregate.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` portfolio account
    ///   2. `[signer]`   owner of the portfolio (also signs the SPL Transfer)
    ///   3. `[writable]` owner's SPL TokenAccount (source)
    ///   4. `[writable]` vault SPL TokenAccount (destination, the PDA in wrapper.vault)
    ///   5. `[]`         SPL Token program
    Deposit { amount: u128 },
    /// Transition the asset slot at `asset_index` from Disabled to Active,
    /// seeding it with a trusted oracle price. `now_slot` comes from the
    /// `Clock` sysvar at the handler.
    ///
    /// NOTE: For MVP the caller signs as "authority" but the wrapper does not
    /// yet pin a specific authority pubkey in the market header, any signer
    /// can activate. A real oracle CPI (Pyth/Switchboard) replaces the trust
    /// model later; here we accept the price as authenticated by the signer.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[signer]`   authority
    ActivateMarket {
        asset_index: u32,
        authenticated_price: u64,
    },
    /// Refresh the oracle price and accrue funding for an active asset slot.
    /// `now_slot` is read from the `Clock` sysvar at the handler.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[signer]`   authority
    AccrueAsset {
        asset_index: u32,
        effective_price: u64,
        funding_rate_e9: i128,
    },
    /// Cross a matched long/short fill through the engine.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` long portfolio
    ///   2. `[writable]` short portfolio
    ///   3. `[signer]`   authority (must own both portfolios for MVP)
    Trade {
        asset_index: u32,
        size_q: u128,
        exec_price: u64,
        fee_bps: u64,
    },
    /// Allocate + initialize the per-market vault SPL TokenAccount at the
    /// PDA recorded in the wrapper header. Must be called once after
    /// InitMarket and before any Deposit.
    ///
    /// Accounts:
    ///   0. `[]`         market account (read for wrapper.authority +
    ///                    wrapper.quote_mint + wrapper.vault verification)
    ///   1. `[signer, writable]` authority, pays rent for the vault account
    ///   2. `[writable]` vault, the PDA at `[VAULT_SEED, market.key()]`,
    ///                    will be allocated by System and initialized as a
    ///                    TokenAccount by SPL Token
    ///   3. `[]`         quote_mint
    ///   4. `[]`         system program
    ///   5. `[]`         token program
    CreateVault,
    /// Symmetric to Deposit: debit `amount` from the portfolio's capital
    /// and transfer the same amount out of the vault TokenAccount to the
    /// owner's token account. Engine requires the portfolio to have zero
    /// active legs and non-negative pnl.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` portfolio account
    ///   2. `[signer]`   owner of the portfolio
    ///   3. `[writable]` vault SPL TokenAccount (source, signs via PDA)
    ///   4. `[writable]` owner's SPL TokenAccount (destination)
    ///   5. `[]`         SPL Token program
    Withdraw { amount: u128 },
    /// Permissionless liquidation: anyone can call to close up to `close_q`
    /// of an unhealthy portfolio's active leg at `asset_index`. Engine
    /// refuses with `NonProgress` if the account's certified liquidation
    /// deficit is zero (i.e. account is still healthy).
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` target portfolio
    ///   2. `[signer]`   liquidator (any signer, pays tx fee)
    Liquidate {
        asset_index: u32,
        close_q: u128,
        fee_bps: u64,
    },
    /// Transition the market from `Live` to `Resolved` (one-way). The
    /// resolved_slot comes from the `Clock` sysvar at the handler.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[signer]`   authority (pinned to wrapper.authority)
    ResolveMarket,
    /// Permissionless cert refresh for `portfolio` against fresh oracle +
    /// funding inputs for `asset_index`. `now_slot` is read from Clock.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` portfolio account
    ///   2. `[signer]`   cranker (any signer; pays tx fee)
    CrankRefresh {
        asset_index: u32,
        effective_price: u64,
        funding_rate_e9: i128,
    },
    /// Create the per-market House Vault portfolio. House is a PDA-owned
    /// portfolio that takes the opposite side of every user `PlaceOrder`.
    /// The market authority calls this once after `InitMarket`/`CreateVault`;
    /// it must be funded via `FundHouseVault` before users can trade.
    ///
    /// Accounts:
    ///   0. `[writable]` market account (wrapper.house_bump gets written)
    ///   1. `[signer, writable]` authority, pays rent for the portfolio
    ///   2. `[writable]` house portfolio, PDA at `[HOUSE_SEED, market.key()]`
    ///   3. `[]`         system program
    CreateHouseVault { house_bump: u8 },
    /// Deposit collateral into the House Vault portfolio. Authority-only.
    /// SPL `Token.Transfer` from the authority's ATA into the market vault
    /// + engine `deposit_not_atomic` credit on the house portfolio.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` house portfolio
    ///   2. `[signer]`   authority (must match wrapper.authority)
    ///   3. `[writable]` authority's SPL TokenAccount (source)
    ///   4. `[writable]` vault SPL TokenAccount (destination)
    ///   5. `[]`         SPL Token program
    FundHouseVault { amount: u128 },
    /// Withdraw realized house P&L back to the authority. Engine refuses
    /// while the house has open positions (active_bitmap non-empty); the
    /// authority can only pull profit when the house is flat.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` house portfolio
    ///   2. `[signer]`   authority
    ///   3. `[writable]` vault SPL TokenAccount (source, signed by vault PDA)
    ///   4. `[writable]` authority's SPL TokenAccount (destination)
    ///   5. `[]`         SPL Token program
    WithdrawHouseVault { amount: u128 },
    /// User-facing single-button trade. `side = 0` (Long) crosses the
    /// user's portfolio as the long side against the House (short side);
    /// `side = 1` (Short) crosses the user as short against the House as
    /// long. Wrapper builds the matched-cross internally so the user only
    /// signs once and never sees a second portfolio.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` user portfolio
    ///   2. `[writable]` house portfolio
    ///   3. `[signer]`   user (must own user_portfolio)
    PlaceOrder {
        side: u8,
        asset_index: u32,
        size_q: u128,
        exec_price: u64,
        fee_bps: u64,
    },
    /// Create a devnet mock constant-product pool with seed reserves, so a
    /// market has a real, swap-movable on-chain price to read. The pool
    /// account is a fresh program-owned account (the client generates the
    /// keypair and pre-funds rent).
    ///
    /// Accounts:
    ///   0. `[writable]` pool account (uninitialized, owned by this program)
    ///   1. `[signer]`   authority (creator)
    ///   2. `[]`         base_mint (read for its pubkey only)
    ///   3. `[]`         quote_mint (read for its pubkey only)
    CreateMockPool {
        reserve_base: u64,
        reserve_quote: u64,
    },
    /// Move a mock pool's price by swapping against its constant product.
    /// `base_to_quote == 1` sells base (price down), `0` buys base (up).
    /// Pure reserve math, no token custody; a devnet price toy.
    ///
    /// Accounts:
    ///   0. `[writable]` pool account
    ///   1. `[signer]`   any signer (pays fee)
    MockSwap {
        amount_in: u64,
        base_to_quote: u8,
    },
    /// Permissionless DEX-EWMA crank: read the market's pinned DEX pool,
    /// compute its spot price, EWMA-fold it into the mark, and accrue.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         pool account (must equal wrapper.oracle_pool)
    ///   2. `[signer]`   any signer (pays fee)
    CrankOracle {
        asset_index: u32,
    },
    /// Authorize (or revoke) a trading delegate, a session key that may sign
    /// `PlaceOrder` for the owner's portfolio without a wallet popup. A zero
    /// `delegate` revokes. Only the portfolio owner can call. The delegate can
    /// never withdraw.
    ///
    /// Accounts:
    ///   0. `[writable]` delegate PDA at `[DELEGATE_SEED, portfolio.key()]`
    ///   1. `[]`         portfolio account (read for its owner)
    ///   2. `[signer, writable]` owner (pays PDA rent on first set)
    ///   3. `[]`         system program
    SetDelegate {
        delegate: [u8; 32],
        bump: u8,
    },
    /// Pin a DEX pool to asset slot `asset_index` (writes the slot wrapper).
    /// Permissionless + pin-once: anyone can claim a free slot's oracle when
    /// listing a pair on the shared market group.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         pool account (the DEX pool to pin)
    ///   2. `[signer]`   any signer (pays fee)
    PinOraclePool {
        asset_index: u32,
    },
    /// Settle a flat account's positive realized PnL into withdrawable
    /// `capital`, debiting the House (counterparty) symmetrically. Bridges
    /// percolator's separate `pnl` ledger so trading profit becomes
    /// withdrawable. Permissionless, only credits the user's own profit into
    /// the user's own portfolio.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` user portfolio (flat; positive realized pnl)
    ///   2. `[writable]` House portfolio (the market's House Vault PDA)
    ///   3. `[signer]`   any signer (pays fee)
    SettlePnl,
    /// Set or rotate a market's oracle authority (the key allowed to move the
    /// mark via `AccrueAsset`). A zero `authority` revokes it, and the gate
    /// falls back to the program constant. Only the market authority may call;
    /// the PDA is created on first use.
    ///
    /// Accounts:
    ///   0. `[writable]`         oracle authority PDA at `[ORACLE_SEED, market.key()]`
    ///   1. `[]`                 market account (read for wrapper.authority)
    ///   2. `[signer, writable]` market authority (pays PDA rent on first set)
    ///   3. `[]`                 system program
    SetOracleAuthority {
        authority: [u8; 32],
        bump: u8,
    },
    /// Set a market's per-portfolio deposit cap for DEX-priced markets.
    /// `max_capital` only raises the cap above the program floor (a deeper pool
    /// supports larger positions); the floor is always enforced. Only the market
    /// authority may call; the PDA is created on first use.
    ///
    /// Accounts:
    ///   0. `[writable]`         deposit cap PDA at `[DEPOSIT_CAP_SEED, market.key()]`
    ///   1. `[]`                 market account (read for wrapper.authority)
    ///   2. `[signer, writable]` market authority (pays PDA rent on first set)
    ///   3. `[]`                 system program
    SetDepositCap {
        max_capital: u128,
        bump: u8,
    },
    /// Permissionless: pull a fresh mark from a Pyth pull-oracle `PriceUpdateV2`
    /// account for a `PYTH` market, bounded by the per-slot move clamp. The
    /// price comes from the verified Pyth account (owner = receiver program,
    /// feed id bound to the market, Full verification, fresh), not the signer.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         Pyth `PriceUpdateV2` account (owned by the receiver)
    ///   2. `[signer]`   any signer (pays fee)
    CrankPyth {
        asset_index: u32,
    },
    /// Bind (or rebind) a DEX-priced market's constant-product pool: the two SPL
    /// token vaults whose balances are the reserves, the base token decimals, and
    /// the minimum quote-side depth. Market-authority-signed. The
    /// `[DEXPOOL_SEED, market]` PDA is created on first use.
    ///
    /// Accounts:
    ///   0. `[writable]` dex pool config PDA
    ///   1. `[]`         market account
    ///   2. `[signer,writable]` market authority (pays PDA rent on first set)
    ///   3. `[]`         System program
    SetDexPool {
        base_vault: [u8; 32],
        quote_vault: [u8; 32],
        base_decimals: u8,
        min_quote_depth: u64,
        bump: u8,
    },
    /// Permissionless: pull a fresh spot from a DEX market's pinned constant-product
    /// pool (two SPL vault balances), reject a too-thin pool, and fold the spot
    /// into the EWMA mark (per-slot move bound + freshness).
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         dex pool config PDA (`[DEXPOOL_SEED, market]`)
    ///   2. `[]`         base reserve vault (SPL token account)
    ///   3. `[]`         quote reserve vault (SPL token account)
    ///   4. `[signer]`   any signer (pays fee)
    CrankDexSpot {
        asset_index: u32,
    },
}

impl OpenPerpsInstruction {
    /// Decode an instruction from its on-chain byte payload.
    pub fn unpack(data: &[u8]) -> Result<Self, OpenPerpsError> {
        let (&tag, rest) = data
            .split_first()
            .ok_or(OpenPerpsError::InvalidInstruction)?;
        match tag {
            tag::INIT_MARKET => {
                let market_group_id = read_pubkey(rest, 0)?;
                let asset_slot_capacity = read_u32(rest, 32)?;
                let vault_bump = *rest
                    .get(36)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                let base_mint = read_pubkey(rest, 37)?;
                let oracle_kind = *rest
                    .get(69)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                let oracle_feed_id = read_pubkey(rest, 70)?;
                let oracle_pool = read_pubkey(rest, 102)?;
                Ok(Self::InitMarket {
                    market_group_id,
                    asset_slot_capacity,
                    vault_bump,
                    base_mint,
                    oracle_kind,
                    oracle_feed_id,
                    oracle_pool,
                })
            }
            tag::INIT_PORTFOLIO => Ok(Self::InitPortfolio {
                bump: read_u8(rest, 0)?,
            }),
            tag::DEPOSIT => Ok(Self::Deposit {
                amount: read_u128(rest, 0)?,
            }),
            tag::ACTIVATE_MARKET => Ok(Self::ActivateMarket {
                asset_index: read_u32(rest, 0)?,
                authenticated_price: read_u64(rest, 4)?,
            }),
            tag::ACCRUE_ASSET => Ok(Self::AccrueAsset {
                asset_index: read_u32(rest, 0)?,
                effective_price: read_u64(rest, 4)?,
                funding_rate_e9: read_i128(rest, 12)?,
            }),
            tag::TRADE => Ok(Self::Trade {
                asset_index: read_u32(rest, 0)?,
                size_q: read_u128(rest, 4)?,
                exec_price: read_u64(rest, 20)?,
                fee_bps: read_u64(rest, 28)?,
            }),
            tag::CREATE_VAULT => Ok(Self::CreateVault),
            tag::WITHDRAW => Ok(Self::Withdraw {
                amount: read_u128(rest, 0)?,
            }),
            tag::LIQUIDATE => Ok(Self::Liquidate {
                asset_index: read_u32(rest, 0)?,
                close_q: read_u128(rest, 4)?,
                fee_bps: read_u64(rest, 20)?,
            }),
            tag::RESOLVE_MARKET => Ok(Self::ResolveMarket),
            tag::CRANK_REFRESH => Ok(Self::CrankRefresh {
                asset_index: read_u32(rest, 0)?,
                effective_price: read_u64(rest, 4)?,
                funding_rate_e9: read_i128(rest, 12)?,
            }),
            tag::CREATE_HOUSE_VAULT => {
                let house_bump = *rest
                    .first()
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::CreateHouseVault { house_bump })
            }
            tag::FUND_HOUSE_VAULT => Ok(Self::FundHouseVault {
                amount: read_u128(rest, 0)?,
            }),
            tag::WITHDRAW_HOUSE_VAULT => Ok(Self::WithdrawHouseVault {
                amount: read_u128(rest, 0)?,
            }),
            tag::PLACE_ORDER => {
                let side = *rest
                    .first()
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::PlaceOrder {
                    side,
                    asset_index: read_u32(rest, 1)?,
                    size_q: read_u128(rest, 5)?,
                    exec_price: read_u64(rest, 21)?,
                    fee_bps: read_u64(rest, 29)?,
                })
            }
            tag::CREATE_MOCK_POOL => Ok(Self::CreateMockPool {
                reserve_base: read_u64(rest, 0)?,
                reserve_quote: read_u64(rest, 8)?,
            }),
            tag::MOCK_SWAP => {
                let amount_in = read_u64(rest, 0)?;
                let base_to_quote = *rest
                    .get(8)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::MockSwap {
                    amount_in,
                    base_to_quote,
                })
            }
            tag::CRANK_ORACLE => Ok(Self::CrankOracle {
                asset_index: read_u32(rest, 0)?,
            }),
            tag::PIN_ORACLE_POOL => Ok(Self::PinOraclePool {
                asset_index: read_u32(rest, 0)?,
            }),
            tag::SET_DELEGATE => {
                let delegate = read_pubkey(rest, 0)?;
                let bump = *rest
                    .get(32)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::SetDelegate { delegate, bump })
            }
            tag::SETTLE_PNL => Ok(Self::SettlePnl),
            tag::SET_ORACLE_AUTHORITY => {
                let authority = read_pubkey(rest, 0)?;
                let bump = *rest
                    .get(32)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::SetOracleAuthority { authority, bump })
            }
            tag::SET_DEPOSIT_CAP => {
                let max_capital = read_u128(rest, 0)?;
                let bump = *rest
                    .get(16)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::SetDepositCap { max_capital, bump })
            }
            tag::CRANK_PYTH => Ok(Self::CrankPyth {
                asset_index: read_u32(rest, 0)?,
            }),
            tag::SET_DEX_POOL => {
                let base_vault = read_pubkey(rest, 0)?;
                let quote_vault = read_pubkey(rest, 32)?;
                let base_decimals = *rest
                    .get(64)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                let min_quote_depth = read_u64(rest, 65)?;
                let bump = *rest
                    .get(73)
                    .ok_or(OpenPerpsError::InvalidInstructionData)?;
                Ok(Self::SetDexPool {
                    base_vault,
                    quote_vault,
                    base_decimals,
                    min_quote_depth,
                    bump,
                })
            }
            tag::CRANK_DEX_SPOT => Ok(Self::CrankDexSpot {
                asset_index: read_u32(rest, 0)?,
            }),
            _ => Err(OpenPerpsError::InvalidInstruction),
        }
    }
}

fn read_i128(data: &[u8], offset: usize) -> Result<i128, OpenPerpsError> {
    let end = offset
        .checked_add(16)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let slice = data
        .get(offset..end)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut buf = [0u8; 16];
    buf.copy_from_slice(slice);
    Ok(i128::from_le_bytes(buf))
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64, OpenPerpsError> {
    let end = offset
        .checked_add(8)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let slice = data
        .get(offset..end)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<[u8; 32], OpenPerpsError> {
    let end = offset
        .checked_add(32)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let slice = data
        .get(offset..end)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut buf = [0u8; 32];
    buf.copy_from_slice(slice);
    Ok(buf)
}

fn read_u8(data: &[u8], offset: usize) -> Result<u8, OpenPerpsError> {
    data.get(offset)
        .copied()
        .ok_or(OpenPerpsError::InvalidInstructionData)
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, OpenPerpsError> {
    let end = offset
        .checked_add(4)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let slice = data
        .get(offset..end)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut buf = [0u8; 4];
    buf.copy_from_slice(slice);
    Ok(u32::from_le_bytes(buf))
}

fn read_u128(data: &[u8], offset: usize) -> Result<u128, OpenPerpsError> {
    let end = offset
        .checked_add(16)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let slice = data
        .get(offset..end)
        .ok_or(OpenPerpsError::InvalidInstructionData)?;
    let mut buf = [0u8; 16];
    buf.copy_from_slice(slice);
    Ok(u128::from_le_bytes(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_init_market() {
        let mut data = vec![tag::INIT_MARKET];
        data.extend_from_slice(&[7u8; 32]);
        data.extend_from_slice(&4u32.to_le_bytes());
        data.push(254);
        data.extend_from_slice(&[9u8; 32]); // base_mint
        data.push(1); // oracle_kind = Pyth
        data.extend_from_slice(&[5u8; 32]); // oracle_feed_id
        data.extend_from_slice(&[6u8; 32]); // oracle_pool
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::InitMarket {
                market_group_id: [7u8; 32],
                asset_slot_capacity: 4,
                vault_bump: 254,
                base_mint: [9u8; 32],
                oracle_kind: 1,
                oracle_feed_id: [5u8; 32],
                oracle_pool: [6u8; 32],
            }
        );
    }

    #[test]
    fn unpack_init_portfolio() {
        let data = vec![tag::INIT_PORTFOLIO, 254u8];
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::InitPortfolio { bump: 254 }
        );
    }

    #[test]
    fn unpack_deposit() {
        let mut data = vec![tag::DEPOSIT];
        let amount: u128 = 1_000_000;
        data.extend_from_slice(&amount.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::Deposit { amount }
        );
    }

    #[test]
    fn unpack_rejects_empty() {
        assert_eq!(
            OpenPerpsInstruction::unpack(&[]),
            Err(OpenPerpsError::InvalidInstruction)
        );
    }

    #[test]
    fn unpack_activate_market() {
        let mut data = vec![tag::ACTIVATE_MARKET];
        data.extend_from_slice(&5u32.to_le_bytes());
        data.extend_from_slice(&12345u64.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::ActivateMarket {
                asset_index: 5,
                authenticated_price: 12345,
            }
        );
    }

    #[test]
    fn unpack_accrue_asset_positive_rate() {
        let mut data = vec![tag::ACCRUE_ASSET];
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&500u64.to_le_bytes());
        data.extend_from_slice(&50i128.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::AccrueAsset {
                asset_index: 1,
                effective_price: 500,
                funding_rate_e9: 50,
            }
        );
    }

    #[test]
    fn unpack_accrue_asset_negative_rate() {
        let mut data = vec![tag::ACCRUE_ASSET];
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&1000u64.to_le_bytes());
        data.extend_from_slice(&(-25i128).to_le_bytes());
        assert!(matches!(
            OpenPerpsInstruction::unpack(&data),
            Ok(OpenPerpsInstruction::AccrueAsset { funding_rate_e9: -25, .. })
        ));
    }

    #[test]
    fn unpack_trade() {
        let mut data = vec![tag::TRADE];
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&1_000_000u128.to_le_bytes());
        data.extend_from_slice(&100_000_000u64.to_le_bytes());
        data.extend_from_slice(&10u64.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::Trade {
                asset_index: 0,
                size_q: 1_000_000,
                exec_price: 100_000_000,
                fee_bps: 10,
            }
        );
    }

    #[test]
    fn unpack_withdraw() {
        let mut data = vec![tag::WITHDRAW];
        let amount: u128 = 250_000;
        data.extend_from_slice(&amount.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::Withdraw { amount }
        );
    }

    #[test]
    fn unpack_liquidate() {
        let mut data = vec![tag::LIQUIDATE];
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&500_000u128.to_le_bytes());
        data.extend_from_slice(&20u64.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::Liquidate {
                asset_index: 0,
                close_q: 500_000,
                fee_bps: 20,
            }
        );
    }

    #[test]
    fn unpack_resolve_market() {
        let data = vec![tag::RESOLVE_MARKET];
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::ResolveMarket
        );
    }

    #[test]
    fn unpack_crank_refresh() {
        let mut data = vec![tag::CRANK_REFRESH];
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&100u64.to_le_bytes());
        data.extend_from_slice(&0i128.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::CrankRefresh {
                asset_index: 0,
                effective_price: 100,
                funding_rate_e9: 0,
            }
        );
    }

    #[test]
    fn unpack_rejects_short_init_market() {
        // tag + 32-byte id + u32 capacity but missing the vault_bump byte.
        let mut data = vec![tag::INIT_MARKET];
        data.extend_from_slice(&[0u8; 32]);
        data.extend_from_slice(&4u32.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data),
            Err(OpenPerpsError::InvalidInstructionData)
        );
    }

    #[test]
    fn unpack_set_oracle_authority() {
        let mut data = vec![tag::SET_ORACLE_AUTHORITY];
        data.extend_from_slice(&[8u8; 32]);
        data.push(253);
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::SetOracleAuthority {
                authority: [8u8; 32],
                bump: 253,
            }
        );
    }

    #[test]
    fn unpack_set_deposit_cap() {
        let mut data = vec![tag::SET_DEPOSIT_CAP];
        data.extend_from_slice(&50_000_000_000u128.to_le_bytes());
        data.push(252);
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::SetDepositCap {
                max_capital: 50_000_000_000,
                bump: 252,
            }
        );
    }

    #[test]
    fn unpack_crank_pyth() {
        let mut data = vec![tag::CRANK_PYTH];
        data.extend_from_slice(&3u32.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::CrankPyth { asset_index: 3 }
        );
    }

    #[test]
    fn unpack_set_dex_pool() {
        let mut data = vec![tag::SET_DEX_POOL];
        data.extend_from_slice(&[1u8; 32]); // base_vault
        data.extend_from_slice(&[2u8; 32]); // quote_vault
        data.push(9); // base_decimals
        data.extend_from_slice(&25_000_000_000u64.to_le_bytes()); // min_quote_depth
        data.push(254); // bump
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::SetDexPool {
                base_vault: [1u8; 32],
                quote_vault: [2u8; 32],
                base_decimals: 9,
                min_quote_depth: 25_000_000_000,
                bump: 254,
            }
        );
    }

    #[test]
    fn unpack_crank_dex_spot() {
        let mut data = vec![tag::CRANK_DEX_SPOT];
        data.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::CrankDexSpot { asset_index: 1 }
        );
    }
}
