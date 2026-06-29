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
    pub const PLACE_BATCH_ORDER: u8 = 26;
    pub const SET_HOUSE_CAP: u8 = 27;
    pub const SET_REQUIRE_VERIFIABLE: u8 = 28;
    pub const FUND_INSURANCE: u8 = 29;
    pub const SET_INSURANCE_PARAMS: u8 = 30;
    pub const REQUEST_INSURANCE_WITHDRAW: u8 = 31;
    pub const EXECUTE_INSURANCE_WITHDRAW: u8 = 32;
    pub const CREATE_HLP_VAULT: u8 = 33;
    pub const SET_HLP_PARAMS: u8 = 34;
    pub const DEPOSIT_HLP: u8 = 35;
    pub const DEPLOY_HLP: u8 = 36;
    pub const REQUEST_REDEEM_HLP: u8 = 37;
    pub const EXECUTE_REDEEM_HLP: u8 = 38;
    pub const HARVEST_HLP: u8 = 39;
    pub const SET_MARKET_FEE: u8 = 40;
    pub const SET_RISK_CONFIG: u8 = 41;
    pub const SET_INSLP_PARAMS: u8 = 42;
    pub const DEPOSIT_INSLP: u8 = 43;
    pub const REQUEST_REDEEM_INSLP: u8 = 44;
    pub const EXECUTE_REDEEM_INSLP: u8 = 45;
    pub const SET_HOUSE_LOCK: u8 = 46;
}

/// Maximum legs in a single `PlaceBatchOrder`. The engine also rejects a batch
/// larger than the market's `max_portfolio_assets`.
pub const MAX_BATCH_LEGS: usize = 8;
/// Encoded size of one `PlaceBatchOrder` leg: side(1) + asset_index(4) +
/// size_q(16) + exec_price(8) + fee_bps(8).
pub const BATCH_LEG_BYTES: usize = 37;

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
        /// Risk tier (see `state::risk_tier`): 0 = Stable (deep-pool / major, 10x,
        /// cheap keeper), 1 = Volatile (pump-dump, wide clamp + short window, 5x,
        /// frequent pushes). Sets the engine config's margin/clamp/window bundle.
        risk_tier: u8,
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
    /// NOTE: the caller signs as "authority" and supplies the seed price;
    /// activation itself is permissionless. The mark is then driven by the
    /// market's oracle: `CrankPyth` reads a receiver-verified Pyth
    /// `PriceUpdateV2` account (a pull-oracle read, not a CPI) and
    /// `CrankDexSpot` reads a constant-product pool, each gated on confidence /
    /// EMA divergence / depth, while a `MANUAL` market keeps its price via the
    /// relayer authority. Here we just accept the seed price from the signer.
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
    /// Like `AccrueAsset`, the supplied `effective_price` / `funding_rate_e9`
    /// only MOVE the mark when the signer is the market's oracle authority; any
    /// other cranker is forced to a delta-0 refresh (the price/funding are
    /// ignored and the current on-chain mark is re-asserted), so a permissionless
    /// crank can drive certification without walking the mark.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` portfolio account
    ///   2. `[signer]`   cranker (any signer; pays tx fee)
    ///   3. `[]`         optional oracle-authority PDA `[ORACLE_SEED, market]`;
    ///                    pass it when cranking as a rotated per-market authority
    ///                    (omit it to gate against the relayer constant)
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
    /// The trailing `[HOUSE_CAP_SEED, market]` PDA (after the optional delegate) is
    /// verified on-chain to be the canonical House-cap address, so it cannot be
    /// omitted or substituted to bypass the cap. When it is initialized the trade
    /// is rejected if it would push the House's net position in the asset past the
    /// cap (de-risking is always allowed); uninitialized means the market has no
    /// House cap.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` user portfolio
    ///   2. `[writable]` house portfolio
    ///   3. `[signer]`   user (must own user_portfolio)
    ///   4. `[]`         delegate PDA (only when the signer is a session key)
    ///   .. `[]`         House-cap PDA `[HOUSE_CAP_SEED, market]` (trailing, required;
    ///                    uninitialized = no cap). Index is 4 with no delegate, 5 with.
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
        /// Slot after which the delegate is rejected by `PlaceOrder`.
        expiry_slot: u64,
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
    /// Funding is priced from the House's net position (skew funding): House
    /// portfolio @3 and House-cap PDA @4 are read (verified canonical, read-only);
    /// with no House cap set they are inert and funding is zero.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         Pyth `PriceUpdateV2` account (owned by the receiver)
    ///   2. `[signer]`   any signer (pays fee)
    ///   3. `[]`         House portfolio PDA `[HOUSE_SEED, market]` (read-only)
    ///   4. `[]`         House-cap PDA `[HOUSE_CAP_SEED, market]` (read-only)
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
    /// pool (two SPL vault balances), reject a too-thin pool, fold the spot into a
    /// rolling TWAP, and move the EWMA mark only once a full window has elapsed
    /// (off the time-weighted average, so a single-block reserve flash cannot
    /// shift it). `bump` is for the `[TWAP_SEED, market, asset_index]` PDA, which
    /// the first crank creates.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[]`         dex pool config PDA (`[DEXPOOL_SEED, market]`)
    ///   2. `[]`         base reserve vault (SPL token account)
    ///   3. `[]`         quote reserve vault (SPL token account)
    ///   4. `[writable]` TWAP-state PDA (`[TWAP_SEED, market, asset_index]`)
    ///   5. `[signer, writable]` cranker (pays fee + the TWAP PDA rent on first use)
    ///   6. `[]`         system program (for the first-use TWAP PDA create)
    ///   7. `[]`         House portfolio PDA `[HOUSE_SEED, market]` (read-only, skew funding)
    ///   8. `[]`         House-cap PDA `[HOUSE_CAP_SEED, market]` (read-only, skew funding)
    CrankDexSpot {
        asset_index: u32,
        bump: u8,
    },
    /// Apply a batch of trade legs (user vs House) in one tx, with a single margin
    /// recertification. The `count` legs follow the tag + count byte in the
    /// instruction data; each leg is side(u8) + asset_index(u32) + size_q(u128) +
    /// exec_price(u64) + fee_bps(u64). `size_q` is the unsigned base size; `side`
    /// 0 = user long, 1 = user short. The trailing `[HOUSE_CAP_SEED, market]` PDA
    /// account is verified and enforced exactly as in `PlaceOrder`.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[writable]` user portfolio
    ///   2. `[writable]` House portfolio
    ///   3. `[signer]`   user (owner or registered delegate)
    ///   4. `[]`         delegate PDA (optional, when the signer is a session key)
    ///   .. `[]`         House-cap PDA `[HOUSE_CAP_SEED, market]` (trailing, required;
    ///                    uninitialized = no cap). Index is 4 with no delegate, 5 with.
    PlaceBatchOrder {
        count: u8,
    },
    /// Set the market's House exposure cap (max net House position per asset, base
    /// units). Only the market authority may call. The `[HOUSE_CAP_SEED, market]`
    /// PDA is created on first use; a zero `max_base_position` disables the cap.
    ///
    /// Accounts:
    ///   0. `[writable]` House-cap PDA (`[HOUSE_CAP_SEED, market]`)
    ///   1. `[]`         market account (read for authority)
    ///   2. `[signer, writable]` authority (must match the market authority; pays rent)
    ///   3. `[]`         system program
    SetHouseCap {
        max_base_position: u128,
        bump: u8,
    },
    /// Set the market's House withdrawal timelock: commit the House seed until
    /// `unlock_slot`, after which `WithdrawHouseVault` is blocked until that slot even
    /// when the House is flat (a rug-proof launch signal). Only the market authority may
    /// call. The `[HOUSE_LOCK_SEED, market]` PDA is created on first use; the value is
    /// raise-only (a creator cannot shorten their own commitment).
    ///
    /// Accounts:
    ///   0. `[writable]` House-lock PDA (`[HOUSE_LOCK_SEED, market]`)
    ///   1. `[]`         market account (read for authority)
    ///   2. `[signer, writable]` authority (must match the market authority; pays rent)
    ///   3. `[]`         system program
    SetHouseLock {
        unlock_slot: u64,
        bump: u8,
    },
    /// Set the market's trading-fee floor: the minimum `fee_bps` every PlaceOrder
    /// / PlaceBatchOrder leg must carry, so a client cannot craft a 0-fee trade to
    /// wash-trade for free or skip funding the engine's insurance backstop. The
    /// PDA is created on first use; a zero `min_fee_bps` removes the floor.
    ///
    /// Accounts:
    ///   0. `[writable]` fee-config PDA (`[FEE_SEED, market]`)
    ///   1. `[]`         market account (read for authority)
    ///   2. `[signer, writable]` authority (must match the market authority; pays rent)
    ///   3. `[]`         system program
    SetMarketFee {
        min_fee_bps: u64,
        bump: u8,
    },
    /// Set (or update) the market's risk config: a dynamic OI multiplier, a
    /// per-wallet position cap, and a stale-pause. The House net position per asset
    /// is bounded by `house_equity * oi_multiplier_bps / 10_000` (base units at the
    /// live mark), any single wallet's net position per asset by
    /// `max_base_position_per_wallet`, and NEW risk-increasing trades are blocked once
    /// the mark has gone un-refreshed past `max_staleness_pause_slots` (de-risking
    /// stays allowed). The caps are layered on the static SetHouseCap ceiling (the
    /// tighter wins). Market-authority-signed; a zero value disables that knob. The
    /// PDA is created on first use, and the trade handlers verify its canonical
    /// address, so it cannot be bypassed by omitting the trailing account.
    ///
    /// Accounts:
    ///   0. `[writable]` risk-config PDA (`[RISK_CFG_SEED, market]`)
    ///   1. `[]`         market account (read for authority)
    ///   2. `[signer, writable]` authority (must match the market authority; pays rent)
    ///   3. `[]`         system program
    SetRiskConfig {
        oi_multiplier_bps: u64,
        max_base_position_per_wallet: u128,
        max_staleness_pause_slots: u64,
        /// Dynamic price-impact spread factor (bps; 0 disables). The trade handlers add
        /// `notional * impact_k_bps / house_equity` to the fee, so larger trades vs the
        /// House depth pay more.
        impact_k_bps: u64,
        /// Dynamic inventory-skew spread factor (bps; 0 disables). Charged only to flow
        /// that increases the House's net inventory (the crowded side).
        skew_k_bps: u64,
        /// Hard ceiling (bps) on the total dynamic spread; 0 turns the whole spread off.
        max_spread_bps: u64,
        bump: u8,
    },
    /// Set the market's `require_verifiable` flag. When enabled, `AccrueAsset`
    /// can no longer move this market's mark (the authority-set price is forced
    /// to a delta-0 accrual); only `CrankPyth` / `CrankDexSpot` price it.
    ///
    /// Accounts:
    ///   0. `[writable]` market account
    ///   1. `[signer]`   authority (must match the market authority)
    SetRequireVerifiable {
        required: u8,
    },
    /// Fund the engine's per-(asset, side) domain insurance by `amount`.
    /// Permissionless: anyone may transfer quote tokens into the backstop (it can
    /// only ever raise the engine's total insurance `I` and the domain budget). The
    /// wrapper moves the tokens into the market vault, then calls the engine's
    /// verified `deposit_domain_insurance_not_atomic`. `side` is 0 = Long, 1 = Short.
    ///
    /// Accounts:
    ///   0. `[writable]` market account (engine vault / insurance / budget updated)
    ///   1. `[signer]`   funder (signs the SPL Transfer)
    ///   2. `[writable]` funder's SPL TokenAccount (source)
    ///   3. `[writable]` market vault SPL TokenAccount (destination, `wrapper.vault`)
    ///   4. `[]`         SPL Token program
    FundInsurance {
        asset_index: u32,
        side: u8,
        amount: u128,
    },
    /// Set (and ratchet) the insurance fund's withdrawal floor and timelock. Only
    /// the market authority may call; the `[INSURANCE_CFG_SEED, market]` PDA is
    /// created on first use. `min_balance` (the floor a withdrawal can never breach)
    /// and `withdraw_delay_slots` (the announce-ahead window) are RAISE-ONLY, so the
    /// fund's guarantees can only strengthen.
    ///
    /// Accounts:
    ///   0. `[writable]`         insurance config PDA `[INSURANCE_CFG_SEED, market]`
    ///   1. `[]`                 market account (read for authority)
    ///   2. `[signer, writable]` market authority (pays PDA rent on first set)
    ///   3. `[]`                 system program
    SetInsuranceParams {
        min_balance: u128,
        withdraw_delay_slots: u64,
        bump: u8,
    },
    /// Request an insurance withdrawal from an (asset, side) domain: records a
    /// pending (amount, unlock slot = now + `withdraw_delay_slots`, domain) after
    /// checking `amount` leaves the floor on the engine's total insurance `I` intact.
    /// Authority-only; no funds move. The withdrawal becomes executable once the
    /// unlock slot passes, so a drain is always announced `withdraw_delay_slots`
    /// ahead. `side` is 0 = Long, 1 = Short. `bump` is the config PDA bump.
    ///
    /// Accounts:
    ///   0. `[writable]` insurance config PDA `[INSURANCE_CFG_SEED, market]`
    ///   1. `[]`         market account (read for authority + engine insurance `I`)
    ///   2. `[signer]`   market authority
    RequestInsuranceWithdraw {
        asset_index: u32,
        side: u8,
        amount: u128,
        bump: u8,
    },
    /// Execute a previously requested insurance withdrawal once its timelock has
    /// elapsed. Re-checks the floor against the live engine insurance `I`, calls the
    /// engine's verified `withdraw_domain_insurance_not_atomic` for the pending
    /// domain, transfers the tokens out signed by the market vault PDA, and clears
    /// the pending slot. Authority-only. `bump` is the config PDA bump (the vault
    /// bump comes from the wrapper header).
    ///
    /// Accounts:
    ///   0. `[writable]` insurance config PDA `[INSURANCE_CFG_SEED, market]`
    ///   1. `[writable]` market account (engine vault / insurance / budget updated)
    ///   2. `[signer]`   market authority
    ///   3. `[writable]` market vault SPL TokenAccount (source, PDA-signed, `wrapper.vault`)
    ///   4. `[writable]` authority's SPL TokenAccount (destination)
    ///   5. `[]`         SPL Token program
    ExecuteInsuranceWithdraw {
        bump: u8,
    },
    /// Create the per-market HLP free-buffer vault: an SPL token account at
    /// `[HLP_VAULT_SEED, market]` for the market's quote mint. Authority-only,
    /// one-time. Holds undeployed LP capital; redemptions are paid from here.
    ///
    /// Accounts:
    ///   0. `[]`                 market account (read for authority + quote_mint)
    ///   1. `[signer, writable]` authority, pays rent for the vault account
    ///   2. `[writable]`         HLP buffer vault PDA `[HLP_VAULT_SEED, market]`
    ///   3. `[]`                 quote_mint
    ///   4. `[]`                 system program
    ///   5. `[]`                 token program
    CreateHlpVault,
    /// Set the HLP config (the `[HLP_SEED, market]` PDA is created on first use).
    /// `redeem_delay_slots` is the redemption timelock, `fee_bps` the deposit/redeem
    /// fee (anti round-trip), `min_deposit` the floor per deposit. Authority-only.
    ///
    /// Accounts:
    ///   0. `[writable]`         HLP config PDA `[HLP_SEED, market]`
    ///   1. `[]`                 market account (read for authority)
    ///   2. `[signer, writable]` authority (pays PDA rent on first set)
    ///   3. `[]`                 system program
    SetHlpParams {
        redeem_delay_slots: u64,
        fee_bps: u64,
        min_deposit: u128,
        nav_haircut_bps: u64,
        bump: u8,
    },
    /// Deposit `amount` quote tokens into the HLP buffer and mint LP shares priced
    /// at the pre-deposit NAV (= buffer balance + the House portfolio's marked
    /// equity). Permissionless (anyone can be an LP). `position_bump` is for the
    /// per-LP `[HLP_POSITION_SEED, market, depositor]` PDA, created on first deposit.
    ///
    /// Accounts:
    ///   0. `[writable]`         HLP config PDA `[HLP_SEED, market]`
    ///   1. `[]`                 market account (read for the House PDA + vault PDAs)
    ///   2. `[signer, writable]` depositor (LP; pays the position PDA rent)
    ///   3. `[writable]`         depositor's SPL TokenAccount (source)
    ///   4. `[writable]`         HLP buffer vault PDA `[HLP_VAULT_SEED, market]` (dest)
    ///   5. `[writable]`         per-LP position PDA `[HLP_POSITION_SEED, market, depositor]`
    ///   6. `[]`                 House portfolio PDA `[HOUSE_SEED, market]` (read for equity)
    ///   7. `[]`                 system program
    ///   8. `[]`                 SPL Token program
    DepositHlp {
        amount: u128,
        position_bump: u8,
    },
    /// Deploy `amount` quote tokens from the HLP buffer into the engine House (the
    /// `FundHouseVault` path: buffer -> market vault + engine House capital credit).
    /// Authority-only, since deploying reduces the free buffer that bounds
    /// redemption liquidity. The House PnL then accrues to NAV, to LP shares.
    ///
    /// Accounts:
    ///   0. `[writable]` market account (engine House capital + vault credited)
    ///   1. `[writable]` House portfolio PDA `[HOUSE_SEED, market]`
    ///   2. `[writable]` HLP buffer vault PDA `[HLP_VAULT_SEED, market]` (source, PDA-signed)
    ///   3. `[writable]` market vault SPL TokenAccount (`wrapper.vault`, destination)
    ///   4. `[signer]`   market authority
    ///   5. `[]`         SPL Token program
    DeployHlp {
        amount: u128,
    },
    /// Request redemption of `shares`: records a pending (shares, unlock = now +
    /// `redeem_delay_slots`) on the LP's position after checking the LP holds them.
    /// No funds move; the LP is priced at the NAV when `ExecuteRedeemHlp` runs (after
    /// the delay), so a redemption cannot snipe a momentary NAV. `position_bump` is
    /// for the `[HLP_POSITION_SEED, market, owner]` PDA.
    ///
    /// Accounts:
    ///   0. `[]`         HLP config PDA `[HLP_SEED, market]` (read for the delay)
    ///   1. `[]`         market account
    ///   2. `[signer]`   LP owner
    ///   3. `[writable]` the LP's position PDA `[HLP_POSITION_SEED, market, owner]`
    RequestRedeemHlp {
        shares: u128,
        position_bump: u8,
    },
    /// Execute a requested redemption once its timelock elapses: prices the pending
    /// shares at the live NAV (buffer + House marked equity), pays out from the buffer
    /// (bounded by the free buffer balance; `HlpBufferInsufficient` if it would
    /// exceed it), burns the shares, and clears the pending slot. The redeem fee stays
    /// in the buffer. `position_bump` is for the position PDA.
    ///
    /// Accounts:
    ///   0. `[writable]` HLP config PDA `[HLP_SEED, market]` (total_shares updated)
    ///   1. `[]`         market account (read for the House + vault PDAs)
    ///   2. `[signer]`   LP owner
    ///   3. `[writable]` owner's SPL TokenAccount (destination)
    ///   4. `[writable]` HLP buffer vault PDA `[HLP_VAULT_SEED, market]` (source, PDA-signed)
    ///   5. `[writable]` the LP's position PDA `[HLP_POSITION_SEED, market, owner]`
    ///   6. `[]`         House portfolio PDA `[HOUSE_SEED, market]` (read for equity)
    ///   7. `[]`         SPL Token program
    ExecuteRedeemHlp {
        position_bump: u8,
    },
    /// Set the InsLP (insurance LP) config (delay, fee, min deposit). Market-
    /// authority-signed; the `[INSLP_SEED, market]` PDA is created on first use. No
    /// engine interaction.
    ///
    /// Accounts:
    ///   0. `[writable]` InsLP config PDA `[INSLP_SEED, market]`
    ///   1. `[]`         market account (read for authority)
    ///   2. `[signer, writable]` market authority (pays rent)
    ///   3. `[]`         system program
    SetInsLpParams {
        redeem_delay_slots: u64,
        fee_bps: u64,
        min_deposit: u128,
        bump: u8,
    },
    /// Deposit `amount` quote tokens into the market's insurance fund and mint InsLP
    /// shares priced at the pre-deposit NAV (= the engine's total insurance `I`).
    /// Permissionless. The tokens land in the market vault and raise engine `I` on the
    /// canonical domain; the fee stays in `I` (accrues to NAV), so a round-trip loses
    /// it. `position_bump` is for the LP position PDA.
    ///
    /// Accounts:
    ///   0. `[writable]` InsLP config PDA `[INSLP_SEED, market]` (total_shares updated)
    ///   1. `[writable]` market account (engine `I` raised on the canonical domain)
    ///   2. `[signer]`   depositor
    ///   3. `[writable]` depositor's SPL TokenAccount (source)
    ///   4. `[writable]` market vault SPL TokenAccount (`wrapper.vault`, destination)
    ///   5. `[writable]` the LP's position PDA `[INSLP_POSITION_SEED, market, owner]`
    ///   6. `[]`         system program
    ///   7. `[]`         SPL Token program
    DepositInsLp {
        amount: u128,
        position_bump: u8,
    },
    /// Request redemption of `shares` InsLP shares: records a pending (shares,
    /// unlock = now + delay) on the LP's position. No funds move; pricing happens at
    /// execute time so a redemption cannot snipe a momentary NAV.
    ///
    /// Accounts:
    ///   0. `[]`         InsLP config PDA `[INSLP_SEED, market]`
    ///   1. `[]`         market account
    ///   2. `[signer]`   LP owner
    ///   3. `[writable]` the LP's position PDA `[INSLP_POSITION_SEED, market, owner]`
    RequestRedeemInsLp {
        shares: u128,
        position_bump: u8,
    },
    /// Execute a requested InsLP redemption once its timelock elapses: prices the
    /// pending shares at the live NAV (engine `I`), pays out from the market vault
    /// (bounded by the canonical domain's engine budget and the insurance floor, if
    /// any), burns the shares, and clears the pending slot. The redeem fee stays in
    /// `I`. `position_bump` is for the position PDA.
    ///
    /// Accounts:
    ///   0. `[writable]` InsLP config PDA `[INSLP_SEED, market]` (total_shares updated)
    ///   1. `[writable]` market account (engine `I` lowered on the canonical domain)
    ///   2. `[signer]`   LP owner
    ///   3. `[writable]` owner's SPL TokenAccount (destination)
    ///   4. `[writable]` market vault SPL TokenAccount (`wrapper.vault`, source, PDA-signed)
    ///   5. `[writable]` the LP's position PDA `[INSLP_POSITION_SEED, market, owner]`
    ///   6. `[]`         insurance config PDA `[INSURANCE_CFG_SEED, market]` (canonical;
    ///                   the redeem floor, uninitialized = no floor)
    ///   7. `[]`         SPL Token program
    ExecuteRedeemInsLp {
        position_bump: u8,
    },
    /// Harvest `amount` of House capital back into the HLP buffer, refilling
    /// redemption liquidity. Withdraws from the engine House (the `WithdrawHouseVault`
    /// path) into the buffer vault. The engine refuses while the House holds open
    /// positions, so this is opportunistic (during flat windows). Authority-only.
    ///
    /// Accounts:
    ///   0. `[writable]` market account (engine House debited)
    ///   1. `[writable]` House portfolio PDA `[HOUSE_SEED, market]`
    ///   2. `[writable]` market vault SPL TokenAccount (`wrapper.vault`, source, PDA-signed)
    ///   3. `[writable]` HLP buffer vault PDA `[HLP_VAULT_SEED, market]` (destination)
    ///   4. `[signer]`   market authority
    ///   5. `[]`         SPL Token program
    HarvestHlp {
        amount: u128,
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
                let risk_tier = read_u8(rest, 134)?;
                Ok(Self::InitMarket {
                    market_group_id,
                    asset_slot_capacity,
                    vault_bump,
                    base_mint,
                    oracle_kind,
                    oracle_feed_id,
                    oracle_pool,
                    risk_tier,
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
                let expiry_slot = read_u64(rest, 33)?;
                Ok(Self::SetDelegate {
                    delegate,
                    bump,
                    expiry_slot,
                })
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
                bump: read_u8(rest, 4)?,
            }),
            tag::PLACE_BATCH_ORDER => {
                let count = *rest.first().ok_or(OpenPerpsError::InvalidInstructionData)?;
                if count == 0 || count as usize > MAX_BATCH_LEGS {
                    return Err(OpenPerpsError::InvalidInstructionData);
                }
                if rest.len() != 1 + count as usize * BATCH_LEG_BYTES {
                    return Err(OpenPerpsError::InvalidInstructionData);
                }
                Ok(Self::PlaceBatchOrder { count })
            }
            tag::SET_HOUSE_CAP => Ok(Self::SetHouseCap {
                max_base_position: read_u128(rest, 0)?,
                bump: read_u8(rest, 16)?,
            }),
            tag::SET_HOUSE_LOCK => Ok(Self::SetHouseLock {
                unlock_slot: read_u64(rest, 0)?,
                bump: read_u8(rest, 8)?,
            }),
            tag::SET_REQUIRE_VERIFIABLE => Ok(Self::SetRequireVerifiable {
                required: read_u8(rest, 0)?,
            }),
            tag::FUND_INSURANCE => Ok(Self::FundInsurance {
                asset_index: read_u32(rest, 0)?,
                side: read_u8(rest, 4)?,
                amount: read_u128(rest, 5)?,
            }),
            tag::SET_INSURANCE_PARAMS => Ok(Self::SetInsuranceParams {
                min_balance: read_u128(rest, 0)?,
                withdraw_delay_slots: read_u64(rest, 16)?,
                bump: read_u8(rest, 24)?,
            }),
            tag::REQUEST_INSURANCE_WITHDRAW => Ok(Self::RequestInsuranceWithdraw {
                asset_index: read_u32(rest, 0)?,
                side: read_u8(rest, 4)?,
                amount: read_u128(rest, 5)?,
                bump: read_u8(rest, 21)?,
            }),
            tag::EXECUTE_INSURANCE_WITHDRAW => Ok(Self::ExecuteInsuranceWithdraw {
                bump: read_u8(rest, 0)?,
            }),
            tag::CREATE_HLP_VAULT => Ok(Self::CreateHlpVault),
            tag::SET_HLP_PARAMS => Ok(Self::SetHlpParams {
                redeem_delay_slots: read_u64(rest, 0)?,
                fee_bps: read_u64(rest, 8)?,
                min_deposit: read_u128(rest, 16)?,
                nav_haircut_bps: read_u64(rest, 32)?,
                bump: read_u8(rest, 40)?,
            }),
            tag::DEPOSIT_HLP => Ok(Self::DepositHlp {
                amount: read_u128(rest, 0)?,
                position_bump: read_u8(rest, 16)?,
            }),
            tag::DEPLOY_HLP => Ok(Self::DeployHlp {
                amount: read_u128(rest, 0)?,
            }),
            tag::REQUEST_REDEEM_HLP => Ok(Self::RequestRedeemHlp {
                shares: read_u128(rest, 0)?,
                position_bump: read_u8(rest, 16)?,
            }),
            tag::EXECUTE_REDEEM_HLP => Ok(Self::ExecuteRedeemHlp {
                position_bump: read_u8(rest, 0)?,
            }),
            tag::HARVEST_HLP => Ok(Self::HarvestHlp {
                amount: read_u128(rest, 0)?,
            }),
            tag::SET_MARKET_FEE => Ok(Self::SetMarketFee {
                min_fee_bps: read_u64(rest, 0)?,
                bump: read_u8(rest, 8)?,
            }),
            tag::SET_RISK_CONFIG => Ok(Self::SetRiskConfig {
                oi_multiplier_bps: read_u64(rest, 0)?,
                max_base_position_per_wallet: read_u128(rest, 8)?,
                max_staleness_pause_slots: read_u64(rest, 24)?,
                impact_k_bps: read_u64(rest, 32)?,
                skew_k_bps: read_u64(rest, 40)?,
                max_spread_bps: read_u64(rest, 48)?,
                bump: read_u8(rest, 56)?,
            }),
            tag::SET_INSLP_PARAMS => Ok(Self::SetInsLpParams {
                redeem_delay_slots: read_u64(rest, 0)?,
                fee_bps: read_u64(rest, 8)?,
                min_deposit: read_u128(rest, 16)?,
                bump: read_u8(rest, 32)?,
            }),
            tag::DEPOSIT_INSLP => Ok(Self::DepositInsLp {
                amount: read_u128(rest, 0)?,
                position_bump: read_u8(rest, 16)?,
            }),
            tag::REQUEST_REDEEM_INSLP => Ok(Self::RequestRedeemInsLp {
                shares: read_u128(rest, 0)?,
                position_bump: read_u8(rest, 16)?,
            }),
            tag::EXECUTE_REDEEM_INSLP => Ok(Self::ExecuteRedeemInsLp {
                position_bump: read_u8(rest, 0)?,
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
        data.push(1); // risk_tier = Volatile
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
                risk_tier: 1,
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
        data.push(254);
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::CrankDexSpot {
                asset_index: 1,
                bump: 254
            }
        );
    }

    #[test]
    fn unpack_place_batch_order() {
        let mut data = vec![tag::PLACE_BATCH_ORDER, 2]; // count = 2
        for _ in 0..2 {
            data.push(0); // side
            data.extend_from_slice(&0u32.to_le_bytes()); // asset_index
            data.extend_from_slice(&1_000_000u128.to_le_bytes()); // size_q
            data.extend_from_slice(&100_000_000u64.to_le_bytes()); // exec_price
            data.extend_from_slice(&10u64.to_le_bytes()); // fee_bps
        }
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::PlaceBatchOrder { count: 2 }
        );
        // count of 0 and over-cap are rejected.
        assert!(OpenPerpsInstruction::unpack(&[tag::PLACE_BATCH_ORDER, 0]).is_err());
        assert!(OpenPerpsInstruction::unpack(&[tag::PLACE_BATCH_ORDER, 99]).is_err());
    }

    #[test]
    fn unpack_fund_insurance() {
        let mut data = vec![tag::FUND_INSURANCE];
        data.extend_from_slice(&2u32.to_le_bytes()); // asset_index
        data.push(1); // side = Short
        data.extend_from_slice(&1_500_000u128.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::FundInsurance {
                asset_index: 2,
                side: 1,
                amount: 1_500_000,
            }
        );
    }

    #[test]
    fn unpack_set_insurance_params() {
        let mut data = vec![tag::SET_INSURANCE_PARAMS];
        data.extend_from_slice(&250_000u128.to_le_bytes()); // min_balance
        data.extend_from_slice(&216_000u64.to_le_bytes()); // withdraw_delay_slots
        data.push(254); // bump
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::SetInsuranceParams {
                min_balance: 250_000,
                withdraw_delay_slots: 216_000,
                bump: 254,
            }
        );
    }

    #[test]
    fn unpack_request_insurance_withdraw() {
        let mut data = vec![tag::REQUEST_INSURANCE_WITHDRAW];
        data.extend_from_slice(&3u32.to_le_bytes()); // asset_index
        data.push(0); // side = Long
        data.extend_from_slice(&50_000u128.to_le_bytes());
        data.push(253); // bump
        assert_eq!(
            OpenPerpsInstruction::unpack(&data).unwrap(),
            OpenPerpsInstruction::RequestInsuranceWithdraw {
                asset_index: 3,
                side: 0,
                amount: 50_000,
                bump: 253,
            }
        );
    }

    #[test]
    fn unpack_execute_insurance_withdraw() {
        assert_eq!(
            OpenPerpsInstruction::unpack(&[tag::EXECUTE_INSURANCE_WITHDRAW, 252]).unwrap(),
            OpenPerpsInstruction::ExecuteInsuranceWithdraw { bump: 252 }
        );
    }

    #[test]
    fn unpack_hlp_setup_and_deposit() {
        assert_eq!(
            OpenPerpsInstruction::unpack(&[tag::CREATE_HLP_VAULT]).unwrap(),
            OpenPerpsInstruction::CreateHlpVault
        );

        let mut p = vec![tag::SET_HLP_PARAMS];
        p.extend_from_slice(&216_000u64.to_le_bytes()); // redeem_delay_slots
        p.extend_from_slice(&10u64.to_le_bytes()); // fee_bps
        p.extend_from_slice(&1_000u128.to_le_bytes()); // min_deposit
        p.extend_from_slice(&2_000u64.to_le_bytes()); // nav_haircut_bps
        p.push(254); // bump
        assert_eq!(
            OpenPerpsInstruction::unpack(&p).unwrap(),
            OpenPerpsInstruction::SetHlpParams {
                redeem_delay_slots: 216_000,
                fee_bps: 10,
                min_deposit: 1_000,
                nav_haircut_bps: 2_000,
                bump: 254,
            }
        );

        let mut d = vec![tag::DEPOSIT_HLP];
        d.extend_from_slice(&5_000_000u128.to_le_bytes());
        d.push(253);
        assert_eq!(
            OpenPerpsInstruction::unpack(&d).unwrap(),
            OpenPerpsInstruction::DepositHlp {
                amount: 5_000_000,
                position_bump: 253,
            }
        );
    }

    #[test]
    fn unpack_hlp_deploy_and_redeem() {
        let mut dep = vec![tag::DEPLOY_HLP];
        dep.extend_from_slice(&3_000_000u128.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&dep).unwrap(),
            OpenPerpsInstruction::DeployHlp { amount: 3_000_000 }
        );

        let mut req = vec![tag::REQUEST_REDEEM_HLP];
        req.extend_from_slice(&1_234u128.to_le_bytes());
        req.push(252);
        assert_eq!(
            OpenPerpsInstruction::unpack(&req).unwrap(),
            OpenPerpsInstruction::RequestRedeemHlp {
                shares: 1_234,
                position_bump: 252,
            }
        );

        assert_eq!(
            OpenPerpsInstruction::unpack(&[tag::EXECUTE_REDEEM_HLP, 251]).unwrap(),
            OpenPerpsInstruction::ExecuteRedeemHlp { position_bump: 251 }
        );

        let mut h = vec![tag::HARVEST_HLP];
        h.extend_from_slice(&2_000_000u128.to_le_bytes());
        assert_eq!(
            OpenPerpsInstruction::unpack(&h).unwrap(),
            OpenPerpsInstruction::HarvestHlp { amount: 2_000_000 }
        );
    }
}
