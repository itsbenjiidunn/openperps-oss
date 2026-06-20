/// Headless trade hook. Wraps the SDK's `buildTradeFromIntent` with the app's
/// wallet adapter: build, sign, confirm. Returns `placeTrade` plus pending and
/// error state. The host app supplies the resolved counterparty and the
/// execution price (from the keeper/on-chain mark, never a client chart price).

import { useCallback, useState } from "react";
import { Transaction, type Commitment } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  buildTradeFromIntent,
  type OpenPerpsMarketConfig,
  type OpenPerpsTradeSide,
  type TradeCounterparty,
} from "@opp-oss/sdk";

export type PlaceTradeInput = {
  side: OpenPerpsTradeSide;
  /// Position size in base units (1e<sizeDecimals>).
  size: string;
  /// Execution price from the keeper/on-chain mark, in the market's price scale.
  executionPrice: bigint;
  feeBps?: bigint;
};

export type UseOpenPerpsTradeResult = {
  placeTrade: (input: PlaceTradeInput) => Promise<string>;
  pending: boolean;
  error: string | null;
};

export function useOpenPerpsTrade(args: {
  market: OpenPerpsMarketConfig;
  counterparty: TradeCounterparty;
  commitment?: Commitment;
}): UseOpenPerpsTradeResult {
  const { market, counterparty } = args;
  const commitment = args.commitment ?? "confirmed";
  const { connection } = useConnection();
  const wallet = useWallet();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeTrade = useCallback(
    async (input: PlaceTradeInput): Promise<string> => {
      setPending(true);
      setError(null);
      try {
        // Inside the try so a disconnected wallet sets `error` (and clears
        // `pending` via finally) instead of throwing past the error state.
        if (!wallet.publicKey || !wallet.sendTransaction) {
          throw new Error("Wallet is not connected.");
        }
        const built = buildTradeFromIntent({
          intent: {
            schemaVersion: 1,
            marketId: market.id,
            side: input.side,
            size: input.size,
          },
          market,
          counterparty,
          executionPrice: input.executionPrice,
          owner: wallet.publicKey,
          feeBps: input.feeBps,
        });
        const tx = new Transaction().add(...built.instructions);
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash(commitment);
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        const signature = await wallet.sendTransaction(tx, connection);
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          commitment,
        );
        return signature;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        throw e;
      } finally {
        setPending(false);
      }
    },
    [connection, wallet, market, counterparty, commitment],
  );

  return { placeTrade, pending, error };
}
