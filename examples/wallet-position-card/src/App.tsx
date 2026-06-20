/// A wallet / portfolio surface: show the connected wallet's OpenPerps positions
/// across a curated set of markets, using @opp-oss/react.

import { type ReactElement } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { OpenPerpsPosition } from "@opp-oss/react";
import type { OpenPerpsMarketConfig } from "@opp-oss/sdk";

const markets: OpenPerpsMarketConfig[] = [
  {
    schemaVersion: 1,
    id: "sol-devnet",
    cluster: "devnet",
    programId: "4zZDZaAEWmVdc6phAKCbpe5CgvZJZosLtpiJUEHnxNzy",
    market: "EZj2ES82yEvo7GFa1LPvitPSpxwK6BqVegP8sasTeZGE",
    assetIndex: 0,
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "SOL-PERP",
    priceDecimals: 6,
    sizeDecimals: 6,
    quoteDecimals: 6,
    riskTier: "major",
    maxLeverage: 20,
    status: "active",
  },
];

export function App(): ReactElement {
  const wallet = useWallet();
  const owner = wallet.publicKey;

  return (
    <main>
      <h1>Your positions</h1>
      <WalletMultiButton />
      {owner ? (
        markets.map((m) => (
          <section key={m.id} style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: 16 }}>{m.symbol}</h2>
            <OpenPerpsPosition market={m} owner={owner} />
          </section>
        ))
      ) : (
        <p>Connect a wallet to view your positions.</p>
      )}
    </main>
  );
}
