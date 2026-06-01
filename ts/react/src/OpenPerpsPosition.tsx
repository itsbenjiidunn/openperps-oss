/// Show a wallet's position summary in a market: capital, realized pnl, and open
/// position count, decoded from the portfolio account. Polls on its own.

import { useEffect, useState, type ReactElement } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  decodePortfolioSummary,
  portfolioPda,
  type DecodedPortfolioSummary,
  type OpenPerpsMarketConfig,
} from "@openperps/sdk";

export type OpenPerpsPositionProps = {
  market: OpenPerpsMarketConfig;
  owner: PublicKey;
  pollMs?: number;
  /// Format a 1e<decimals> atom amount for display. Defaults to the raw integer.
  formatAmount?: (atoms: bigint) => string;
  className?: string;
};

export function OpenPerpsPosition({
  market,
  owner,
  pollMs,
  formatAmount,
  className,
}: OpenPerpsPositionProps): ReactElement {
  const { connection } = useConnection();
  const [summary, setSummary] = useState<DecodedPortfolioSummary | null>(null);

  useEffect(() => {
    let active = true;
    const programId = new PublicKey(market.programId);
    const marketAccount = new PublicKey(market.market);
    const [portfolio] = portfolioPda(programId, owner, marketAccount);
    const tick = (): void => {
      connection
        .getAccountInfo(portfolio)
        .then((info) => {
          if (!active) return;
          if (!info) {
            setSummary(null);
            return;
          }
          const u = new Uint8Array(
            info.data.buffer,
            info.data.byteOffset,
            info.data.byteLength,
          );
          setSummary(decodePortfolioSummary(u));
        })
        .catch(() => {
          /* transient RPC error; keep the last good summary */
        });
    };
    tick();
    const id = setInterval(tick, pollMs ?? 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [connection, market.programId, market.market, owner, pollMs]);

  const fmt = formatAmount ?? ((a: bigint) => a.toString());

  return (
    <div className={className ?? "openperps-position"}>
      {summary ? (
        <>
          <span className="openperps-position-capital">{fmt(summary.capital)}</span>
          <span className="openperps-position-pnl">{fmt(summary.pnl)}</span>
          <span className="openperps-position-count">{summary.positions.length}</span>
        </>
      ) : (
        <span className="openperps-position-empty">no position</span>
      )}
    </div>
  );
}
