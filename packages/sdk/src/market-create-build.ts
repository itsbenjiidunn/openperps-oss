/// High-level market creation builder: compose the on-chain instructions for a
/// custom market from a creation intent. Build-only (no RPC): the caller fetches
/// the market account rent and supplies a fresh market keypair, then signs.
///
/// Order matches `planMarketCreation`: create the market account, InitMarket,
/// CreateVault, CreateHouseVault, FundHouseVault (when an initial deposit is
/// given), ActivateMarket.

import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  activateMarketIx,
  createHouseVaultIx,
  createVaultIx,
  fundHouseVaultIx,
  initMarketIx,
} from "./instructions.ts";
import { HOUSE_SEED, VAULT_SEED, marketAccountSize } from "./layout.ts";
import type { OpenPerpsMarketCreationIntent } from "./intents.ts";

export type BuildMarketCreationInput = {
  intent: OpenPerpsMarketCreationIntent;
  programId: PublicKey;
  /// The market authority. Pays rent, signs every creation instruction.
  authority: PublicKey;
  /// A fresh keypair public key for the market account. The caller must also add
  /// that keypair as a signer.
  market: PublicKey;
  /// Rent-exempt lamports for the market account (from
  /// `connection.getMinimumBalanceForRentExemption(marketAccountSize(cap))`).
  marketRentLamports: number;
  assetSlotCapacity: number;
  assetIndex?: number;
  /// The authority's quote-mint token account, required when the intent funds
  /// the House (`lpVault.initialDeposit`).
  authorityQuoteToken?: PublicKey;
  /// Oracle binding. Defaults to manual (kind 0) with empty feed/pool.
  oracleKind?: number;
  oracleFeedId?: Uint8Array;
  oraclePool?: PublicKey;
  /// Risk tier (see `RISK_TIER_*`): 0 = Stable (10x, cheap keeper), 1 = Volatile
  /// (pump-dump, 5x, wide clamp + frequent pushes). Defaults to Stable.
  riskTier?: number;
};

export type MarketCreationBuild = {
  instructions: TransactionInstruction[];
  market: PublicKey;
  vault: PublicKey;
  housePortfolio: PublicKey;
  vaultBump: number;
  houseBump: number;
  marketGroupId: Uint8Array;
};

export function buildMarketCreationInstructions(
  input: BuildMarketCreationInput,
): MarketCreationBuild {
  const { intent, programId, authority, market } = input;
  const assetIndex = input.assetIndex ?? 0;
  const quoteMint = new PublicKey(intent.quoteMint);
  const baseMint = new PublicKey(intent.baseMint);

  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    programId,
  );
  const [housePortfolio, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.toBuffer()],
    programId,
  );

  // The market account is the group; use its key bytes as the group id.
  const marketGroupId = market.toBytes();

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: authority,
      newAccountPubkey: market,
      lamports: input.marketRentLamports,
      space: marketAccountSize(input.assetSlotCapacity),
      programId,
    }),
    initMarketIx({
      programId,
      market,
      authority,
      quoteMint,
      marketGroupId,
      assetSlotCapacity: input.assetSlotCapacity,
      vaultBump,
      baseMint,
      oracleKind: input.oracleKind ?? 0,
      oracleFeedId: input.oracleFeedId ?? new Uint8Array(32),
      oraclePool: input.oraclePool ?? PublicKey.default,
      riskTier: input.riskTier ?? 0,
    }),
    createVaultIx({ programId, market, authority, vault, quoteMint }),
    createHouseVaultIx({ programId, market, authority, housePortfolio, houseBump }),
  ];

  const initialDeposit = intent.lpVault?.initialDeposit;
  if (initialDeposit !== undefined) {
    if (!input.authorityQuoteToken) {
      throw new Error(
        "authorityQuoteToken is required to fund the House (lpVault.initialDeposit set)",
      );
    }
    instructions.push(
      fundHouseVaultIx({
        programId,
        market,
        housePortfolio,
        authority,
        authorityToken: input.authorityQuoteToken,
        vaultToken: vault,
        amount: BigInt(initialDeposit),
      }),
    );
  }

  instructions.push(
    activateMarketIx({
      programId,
      market,
      authority,
      assetIndex,
      authenticatedPrice: BigInt(intent.initialPrice),
    }),
  );

  return {
    instructions,
    market,
    vault,
    housePortfolio,
    vaultBump,
    houseBump,
    marketGroupId,
  };
}
