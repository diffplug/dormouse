import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { relayDefineVitePlugin, relayOriginDefine, resolveRelayOrigin } from "../scripts/relay-origin.mjs";

const libDir = path.resolve(import.meta.dirname, "../lib");
const dorDir = path.resolve(import.meta.dirname, "../dor");
const dorToolsBuiltinDir = path.resolve(import.meta.dirname, "../dor-tools-builtin");
const dorToolsLibDir = path.resolve(import.meta.dirname, "../dor-tools-lib");
const remoteLibCommonDir = path.resolve(import.meta.dirname, "../remote-lib-common");

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
const port = Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 1420);

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), relayDefineVitePlugin()],
  // The relay pair the sidecar bakes, under the same rule: the dev server is a
  // dev build and `vite build` a release one, which fails if the define did not
  // reach a chunk (docs/specs/relay.md → "Relay origin").
  define: relayOriginDefine(resolveRelayOrigin(process.env, "webview", { dev: command === "serve" })),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "dormouse-lib": path.resolve(libDir, "src"),
      // lib source imports the `dor` workspace package via the `dor/*` tsconfig
      // path; Vite governs lib files by lib's (paths-less) tsconfig, and `dor`
      // has no package exports, so resolve it explicitly the same way as lib.
      dor: path.resolve(dorDir, "src"),
      // The same for the built-in viewers' format registry. `vite build` also
      // finds it through lib's tsconfig `paths`, but the dev server does not.
      "dor-tools-builtin": path.resolve(dorToolsBuiltinDir, "src"),
      // And the Tool protocol the terminal parser and `IframePanel` speak.
      "dor-tools-lib": path.resolve(dorToolsLibDir, "src"),
      // lib source imports the remote modules, which import `remote-lib-common`;
      // its package exports point at dist, which a clean standalone checkout
      // build has not necessarily produced yet. Match the Pocket and website
      // builds by resolving it directly to source.
      "remote-lib-common": path.resolve(remoteLibCommonDir, "src"),
    },
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
      allow: [libDir, dorDir, dorToolsBuiltinDir, dorToolsLibDir, remoteLibCommonDir, "."],
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
