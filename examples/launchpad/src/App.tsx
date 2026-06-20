/// A launchpad surface: create a perp market for a launching token, then offer
/// trading on it, using @opp-oss/react.

import { useState, type ReactElement } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  OpenPerpsMarketLauncher,
  type OpenPerpsMarketCreationIntent,
} from "@opp-oss/react";

const intent: OpenPerpsMarketCreationIntent = {
  schemaVersion: 1,
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "MYTOKEN-PERP",
  initialPrice: "1000000",
  maxLeverage: 5,
  riskTier: "experimental",
  priceProvider: { type: "external", id: "my-launchpad-feed" },
  lpVault: { initialDeposit: "50000000" },
};

export function App(): ReactElement {
  const [launched, setLaunched] = useState(false);

  return (
    <main>
      <h1>Launch a perp for {intent.symbol}</h1>
      <WalletMultiButton />
      <p style={{ color: "#8b97a8" }}>
        Create an isolated perp market for your token, seed the House, and offer
        long/short on your launch page.
      </p>
      <OpenPerpsMarketLauncher
        intent={intent}
        onLaunch={() => setLaunched(true)}
      />
      {launched ? (
        <p>
          Creation plan ready. Sign with the authority wallet to create the
          market, then embed a trade widget here.
        </p>
      ) : null}
    </main>
  );
}
