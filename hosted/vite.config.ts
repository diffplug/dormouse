import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";
import { themeBootPlugin } from "../lib/src/lib/themes/boot-paint-plugin";
import { DOCS_PAINT_PROFILE } from "../lib/src/site/docs-paint";
export default defineConfig({
  plugins: [react(), tailwindcss(), themeBootPlugin(DOCS_PAINT_PROFILE)],
  resolve: { alias: workspaceSourceAliases() },
  // Each Worker's static files build under `dist/<worker>/`.
  build: { outDir: "dist/account", sourcemap: false },
});
