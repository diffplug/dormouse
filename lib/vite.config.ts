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
    },
  },
});
