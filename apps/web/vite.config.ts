import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendors out of the main bundle so
        // they cache independently and load in parallel (was one ~830 kB chunk).
        manualChunks: {
          solana: [
            "@solana/web3.js",
            "@solana/spl-token",
            "@solana/wallet-adapter-base",
            "@solana/wallet-adapter-react",
            "@solana/wallet-adapter-react-ui",
          ],
          charts: ["lightweight-charts"],
        },
      },
    },
  },
});
