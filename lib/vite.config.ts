import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      // lib source imports the `dor` workspace package via the `dor/*` tsconfig
      // path; Vite (and vitest) do not read tsconfig paths, and `dor` has no
      // package exports, so resolve it to source — the same alias standalone uses.
      dor: path.resolve(__dirname, "../dor/src"),
      // `connect-port.ts` imports `dor-lib-common/agent-browser`; that package's
      // `exports` resolve to a `dist` a vitest run has no reason to have built.
      // Alias to source so the tests never depend on build order.
      "dor-lib-common": path.resolve(__dirname, "../dor-lib-common/src"),
    },
  },
});
