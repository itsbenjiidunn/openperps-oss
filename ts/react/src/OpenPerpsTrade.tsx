/// A minimal, unstyled Long/Short widget built on `useOpenPerpsTrade`. The host
/// app supplies the market config, the resolved counterparty, and the current
/// execution price (from the keeper/on-chain mark). Styling is left to the host
/// via `className`; the default class names carry no built-in CSS.

import { useState, type ReactElement } from "react";
import type { Commitment } from "@solana/web3.js";
import type { OpenPerpsMarketConfig, TradeCounterparty } from "@openperps/sdk";
import { useOpenPerpsTrade } from "./useOpenPerpsTrade.ts";

export type OpenPerpsTradeProps = {
  market: OpenPerpsMarketConfig;
  counterparty: TradeCounterparty;
  /// Execution price in the market's price scale, from the keeper/on-chain mark.
  executionPrice: bigint;
  /// Initial size in base units. Defaults to one unit at `sizeDecimals`.
  defaultSize?: string;
  commitment?: Commitment;
  onFilled?: (signature: string) => void;
  className?: string;
};

export function OpenPerpsTrade({
  market,
  counterparty,
  executionPrice,
  defaultSize,
  commitment,
  onFilled,
  className,
}: OpenPerpsTradeProps): ReactElement {
  const { placeTrade, pending, error } = useOpenPerpsTrade({
    market,
    counterparty,
    commitment,
  });
  const [size, setSize] = useState<string>(
    defaultSize ?? (10 ** market.sizeDecimals).toString(),
  );

  const submit = async (side: "long" | "short"): Promise<void> => {
    const signature = await placeTrade({ side, size, executionPrice });
    onFilled?.(signature);
  };

  return (
    <div className={className ?? "openperps-trade"}>
      <input
        className="openperps-trade-size"
        type="text"
        inputMode="numeric"
        value={size}
        disabled={pending}
        onChange={(e) => setSize(e.target.value.replace(/[^0-9]/g, ""))}
      />
      <button
        className="openperps-trade-long"
        type="button"
        disabled={pending || size.length === 0}
        onClick={() => void submit("long")}
      >
        Long
      </button>
      <button
        className="openperps-trade-short"
        type="button"
        disabled={pending || size.length === 0}
        onClick={() => void submit("short")}
      >
        Short
      </button>
      {error ? (
        <p className="openperps-trade-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
