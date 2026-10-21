import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: workspaceSourceAliases() },
  // Each Worker's static files build under `dist/<worker>/`.
  build: { outDir: "dist/account", sourcemap: false },
});
