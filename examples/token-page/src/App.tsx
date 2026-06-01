/// A token page: one market config mapped to one token, with the OpenPerps chart,
/// trade, and position widgets embedded from @openperps/react.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  OpenPerpsChart,
  OpenPerpsPosition,
  OpenPerpsTrade,
  type Candle,
} from "@openperps/react";
import {
  HOUSE_SEED,
  readU64LE,
  slotEffectivePriceOffset,
  type OpenPerpsMarketConfig,
} from "@openperps/sdk";

const RPC = "https://api.devnet.solana.com";

const market: OpenPerpsMarketConfig = {
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
};

// The shared House/LP counterparty for an official market is the market's House
// PDA. A custom market would pass its creator's House.
function useHouseCounterparty(): { housePortfolio: string } {
  return useMemo(() => {
    const [house] = PublicKey.findProgramAddressSync(
      [HOUSE_SEED, new PublicKey(market.market).toBuffer()],
      new PublicKey(market.programId),
    );
    return { housePortfolio: house.toBase58() };
  }, []);
}

// Read the on-chain mark for the execution price (never a client chart price).
function useMark(): bigint {
  const [mark, setMark] = useState<bigint>(0n);
  useEffect(() => {
    const connection = new Connection(RPC, "confirmed");
    const marketAccount = new PublicKey(market.market);
    const tick = (): void => {
      connection
        .getAccountInfo(marketAccount)
        .then((info) => {
          if (!info) return;
          const u = new Uint8Array(
            info.data.buffer,
            info.data.byteOffset,
            info.data.byteLength,
          );
          const off = slotEffectivePriceOffset(market.assetIndex);
          if (off + 8 <= u.length) setMark(readU64LE(u, off));
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);
  return mark;
}

// Demo candles: a host app feeds its own chart data; this is a placeholder.
function demoCandles(): Candle[] {
  return Array.from({ length: 24 }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 4;
    return { time: i, open: close, high: close + 1, low: close - 1, close };
  });
}

export function App(): ReactElement {
  const wallet = useWallet();
  const counterparty = useHouseCounterparty();
  const mark = useMark();
  const candles = useMemo(() => demoCandles(), []);

  return (
    <main>
      <h1>{market.symbol}</h1>
      <WalletMultiButton />
      <OpenPerpsChart market={market} candles={candles} width={420} height={140} />
      <OpenPerpsTrade
        market={market}
        counterparty={counterparty}
        executionPrice={mark}
        onFilled={(sig) => console.log("filled", sig)}
      />
      {wallet.publicKey ? (
        <OpenPerpsPosition market={market} owner={wallet.publicKey} />
      ) : (
        <p>Connect a wallet to view your position.</p>
      )}
    </main>
  );
}
