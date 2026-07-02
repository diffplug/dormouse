import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Second entry, separate from the main `lib` app (index.html): the standalone
// Pocket phone web app. Its HTML lives in `pocket/index.html` and pulls in
// `src/remote/pocket-app/main.tsx`; the build lands in `dist-pocket/` for the
// server to serve statically (docs/specs/pocket-app.md). It shares the full
// terminal UI (`MobileTerminalUi`/`MobileWall`) with the main app, so it needs
// the same Tailwind + `--vscode-*` theme plumbing (`src/index.css`); the auth
// views layer their own self-contained `pocket.css` on top.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL("./pocket", import.meta.url)),
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    emptyOutDir: true,
  },
});
