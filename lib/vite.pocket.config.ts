import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Second entry, separate from the main `lib` app (index.html): the standalone
// Pocket phone web app. Its HTML lives in `pocket/index.html` and pulls in
// `src/pocket/main.tsx`; the build lands in `dist-pocket/` for the server to
// serve statically (docs/specs/server.md "Pocket side"). No Tailwind/VSCode
// theme plumbing — Pocket ships its own self-contained CSS.
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL("./pocket", import.meta.url)),
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    emptyOutDir: true,
  },
});
