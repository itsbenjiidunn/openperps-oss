/// A DEX terminal surface: a market list with a filter, a chart shell, and a
/// trade panel for the selected market, using @openperps/react.

import { useMemo, useState, type ReactElement } from "react";
import { PublicKey } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { OpenPerpsChart, OpenPerpsTrade, type Candle } from "@openperps/react";
import { HOUSE_SEED, type OpenPerpsMarketConfig } from "@openperps/sdk";

const base = {
  schemaVersion: 1 as const,
  cluster: "devnet" as const,
  programId: "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy",
  market: "EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  priceDecimals: 6,
  sizeDecimals: 6,
  quoteDecimals: 6,
  maxLeverage: 20,
  status: "active" as const,
};

const markets: OpenPerpsMarketConfig[] = [
  { ...base, id: "sol-devnet", assetIndex: 0, baseMint: "So11111111111111111111111111111111111111112", symbol: "SOL-PERP", riskTier: "major" },
  { ...base, id: "demo-devnet", assetIndex: 1, baseMint: "So11111111111111111111111111111111111111112", symbol: "DEMO-PERP", riskTier: "experimental" },
];

function houseFor(m: OpenPerpsMarketConfig): { housePortfolio: string } {
  const [house] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, new PublicKey(m.market).toBuffer()],
    new PublicKey(m.programId),
  );
  return { housePortfolio: house.toBase58() };
}

function demoCandles(): Candle[] {
  return Array.from({ length: 24 }, (_, i) => {
    const close = 100 + Math.cos(i / 3) * 4;
    return { time: i, open: close, high: close + 1, low: close - 1, close };
  });
}

export function App(): ReactElement {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState(markets[0].id);

  const filtered = markets.filter((m) =>
    m.symbol.toLowerCase().includes(filter.toLowerCase()),
  );
  const selected = markets.find((m) => m.id === selectedId) ?? markets[0];
  const candles = useMemo(() => demoCandles(), []);

  return (
    <main>
      <h1>Markets</h1>
      <WalletMultiButton />
      <input
        placeholder="filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ display: "block", margin: "12px 0", padding: 8, width: "100%" }}
      />
      <ul style={{ listStyle: "none", padding: 0 }}>
        {filtered.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => setSelectedId(m.id)}>
              {m.symbol} ({m.riskTier})
            </button>
          </li>
        ))}
      </ul>
      <h2 style={{ fontSize: 16 }}>{selected.symbol}</h2>
      <OpenPerpsChart market={selected} candles={candles} width={420} height={140} />
      {/* execPrice 0 is a placeholder; a real terminal reads the on-chain mark. */}
      <OpenPerpsTrade market={selected} counterparty={houseFor(selected)} executionPrice={0n} />
    </main>
  );
}
