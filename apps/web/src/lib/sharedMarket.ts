/// The single shared market group that gives OpenPerps real cross-margin:
/// one group, many asset slots, one vault, one shared House Vault, and one
/// portfolio per user. Bootstrapped once on devnet via
/// `ts/sdk/scripts/bootstrap-shared-group.ts`. "Launching a market" no longer
/// creates a group, it claims a free asset slot in THIS group.

import { PublicKey } from "@solana/web3.js";

export const SHARED_MARKET = new PublicKey("EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE");
export const SHARED_VAULT = new PublicKey("75LaQ2aGjbk5XrHUEFy8AgGkLCX72DA2zcjx6qHHFm7R");
export const SHARED_HOUSE = new PublicKey("5buZR7SrG6D3t2Ste5HkmWxSkaDwZpmSYvFDuwwcxKqa");
export const SHARED_HOUSE_BUMP = 253;
export const SHARED_SLOT_CAPACITY = 16;

/// The group's `max_trading_fee_bps` as baked into the shared market's
/// on-chain config (see `default_market_config` in the program). PlaceOrder
/// passes a per-trade `fee_bps`, and the engine rejects any trade where
/// `fee_bps > max_trading_fee_bps` with `InvalidConfig`, which the wallet
/// surfaces as a generic "Unexpected error". Every per-trade fee MUST be
/// clamped to this cap, and the launch UI must not advertise a higher fee.
export const GROUP_MAX_FEE_BPS = 10;
