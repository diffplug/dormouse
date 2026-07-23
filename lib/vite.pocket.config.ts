import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Second entry, separate from the main `lib` app (index.html): the standalone
// Pocket phone web app. Its HTML lives in `pocket/index.html` and pulls in
// `src/remote/pocket-app/main.tsx`; the build lands in `dist-pocket/` for the
// server to serve statically (docs/specs/pocket-app.md). It shares the full
// terminal UI (`MobileTerminalUi`/`MobileWall`) and the themeable design
// system with the main app, so it needs the same Tailwind + `--vscode-*`
// theme plumbing (`src/index.css`); the HTML shell carries the structural
// viewport rules inline.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL("./pocket", import.meta.url)),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      // The Pocket app imports the remote modules, which import
      // `server-lib-common`; its package `exports` resolve to a `dist` that a
      // clean checkout has not built yet (this vite-only build has no `tsc -b`
      // step to generate it). Alias to source, same as the website and
      // Storybook configs.
      "server-lib-common": fileURLToPath(new URL("../server-lib-common/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    emptyOutDir: true,
  },
});
