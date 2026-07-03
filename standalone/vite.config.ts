import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const libDir = path.resolve(__dirname, "../lib");
const dorDir = path.resolve(__dirname, "../dor");
const serverLibCommonDir = path.resolve(__dirname, "../server-lib-common");

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
const port = Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 1420);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "dormouse-lib": path.resolve(libDir, "src"),
      // lib source imports the `dor` workspace package via the `dor/*` tsconfig
      // path; Vite governs lib files by lib's (paths-less) tsconfig, and `dor`
      // has no package exports, so resolve it explicitly the same way as lib.
      dor: path.resolve(dorDir, "src"),
      // lib source imports the remote modules, which import `server-lib-common`;
      // its package exports point at dist, which a clean standalone checkout
      // build has not necessarily produced yet. Match the Pocket and website
      // builds by resolving it directly to source.
      "server-lib-common": path.resolve(serverLibCommonDir, "src"),
    },
  },
  // Tauri expects a fixed port; fail if that port is not available
  server: {
    host: host || false,
    port,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    fs: {
      // Allow serving files from the source-aliased workspace packages.
      allow: [libDir, dorDir, serverLibCommonDir, "."],
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
});
