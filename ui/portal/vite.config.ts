import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output is embedded into the manager binary (services/manager/uidist via
// go:embed); the dev server proxies API calls to a locally running manager.
// Override the manager origin with MANAGER_ORIGIN when :8080 is taken.
const manager = process.env.MANAGER_ORIGIN || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../services/manager/uidist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": { target: manager, ws: true },
      "/auth": manager,
    },
  },
});
