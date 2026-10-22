import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { buildStampVitePlugin } from "../scripts/build-stamp.mjs";
import { relayDefineVitePlugin, relayOriginDefine, resolveRelayOrigin } from "../scripts/relay-origin.mjs";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";
import { themeBootPlugin } from "../lib/src/lib/themes/boot-paint-plugin";
import { resolveThemeVars } from "../lib/src/lib/themes/apply";
import { themePaintFor } from "../lib/src/lib/themes/boot-paint";
import { getBundledThemes } from "../lib/src/lib/themes/store";

// The app restores with no default of its own, so a first launch takes the
// first bundled theme (`restoreActiveTheme`).
const [firstTheme] = getBundledThemes();

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
const port = Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 1420);

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    relayDefineVitePlugin(),
    buildStampVitePlugin({ host: "standalone" }),
    themeBootPlugin("app", themePaintFor(firstTheme, resolveThemeVars(firstTheme))),
  ],
  // The relay pair the sidecar bakes, under the same rule: the dev server is a
  // dev build and `vite build` a release one, which fails if the define did not
  // reach a chunk (docs/specs/relay.md → "Relay origin").
  define: relayOriginDefine(resolveRelayOrigin(process.env, "webview", { dev: command === "serve" })),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: workspaceSourceAliases(),
  },
  // Direct Tauri CLI defaults; the dev runners override the listener in-process.
  server: {
    host: host || false,
    port,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // The Tauri CLI rebuilds the Rust side itself. Watching `target/` also
    // crashes on Windows, where a build script Cargo is still writing is
    // locked and `fs.watch` throws EBUSY.
    watch: { ignored: ["**/src-tauri/**"] },
    fs: {
      // Allow serving files from the source-aliased workspace packages.
      allow: [...Object.values(workspaceSourceAliases()), "."],
    },
  },
  // Tauri CLI reads this env var to know where the dev server is
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS/Linux
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
