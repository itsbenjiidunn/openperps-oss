// Buffer polyfill, must run before any Solana dependency is evaluated.
import "./polyfills";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App } from "./App.tsx";

const RPC = "https://api.devnet.solana.com";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <ConnectionProvider endpoint={RPC}>
      {/* Empty wallet list: Wallet Standard wallets (Phantom, Solflare) auto-register. */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
