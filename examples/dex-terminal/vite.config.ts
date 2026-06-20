import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The `@opp-oss/*` packages ship TypeScript source, so let Vite compile them
// from node_modules alongside the app.
export default defineConfig({
  plugins: [react()],
});
