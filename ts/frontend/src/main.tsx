// Polyfill Node's Buffer in the browser. @solana/web3.js, @solana/spl-token,
// and our own SDK all call `Buffer.from(...)` internally; without this
// they explode at runtime with "Buffer is not defined". Vite does not
// auto-polyfill it — keep this as the very first import.
import { Buffer } from "buffer";
if (typeof window !== "undefined" && !window.Buffer) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getRouter } from "./router";
import { SolanaProviders } from "./wallet/SolanaProviders";

// Defaults tuned so connecting a wallet stays snappy. `refetchOnWindowFocus`
// (react-query's default) refetches EVERY active query whenever the tab regains
// focus — which is exactly what happens when the Phantom/Solflare popup closes
// after approval. That refetch burst contends with the extension's postMessage
// round-trip and drags out the "Connecting…" state. Components already poll via
// their own `refetchInterval`, so focus-refetch buys nothing here. Cap retries
// too so a transient RPC hiccup can't fan a query into a long backoff storm.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});
const router = getRouter(queryClient);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SolanaProviders>
        <RouterProvider router={router} />
      </SolanaProviders>
    </QueryClientProvider>
  </StrictMode>,
);
