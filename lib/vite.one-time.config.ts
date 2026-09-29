import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { ONE_TIME_PAGE_PATH } from "../remote-lib-common/src/security/one-time-link.ts";
import pocketConfig from "./vite.pocket.config.ts";

// Third entry: the one-time phone page (docs/specs/one-time.md -> "Phone
// page"). Its HTML lives in `one-time/index.html` and pulls in
// `src/remote/one-time-app/main.tsx`; the build lands in `dist-one-time/` for
// Hosted to stage under `/connect/`. It renders Pocket's screens and mobile
// wall, so it takes Pocket's resolution (the source aliases and the React
// dedupe) and the same Tailwind + theme plumbing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL("./one-time", import.meta.url)),
  // The page path the link grammar names, so every emitted URL is under it and
  // Hosted's `script-src` can name `/connect/assets/` alone.
  base: ONE_TIME_PAGE_PATH,
  resolve: pocketConfig.resolve,
  build: {
    // The polyfill is an inline script, which the page's policy refuses;
    // `assertPocketShell` would fail the build on it.
    modulePreload: { polyfill: false },
    outDir: fileURLToPath(new URL("./dist-one-time", import.meta.url)),
    emptyOutDir: true,
  },
});
