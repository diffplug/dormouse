import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { CSP_NONCE_PLACEHOLDER } from "./src/csp-nonce-placeholder";

/**
 * Builds the lib frontend for embedding in the VSCode extension webview.
 * Output goes to vscode-ext/media/ which the extension serves as a webview.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  html: {
    // Vite stamps this placeholder onto every tag it emits that loads a script
    // or style, and onto a `<meta property="csp-nonce">` that its own runtime
    // preload helper reads. `webview-html.ts` swaps it for a fresh per-render
    // nonce when it serves the document — the placeholder must never reach a
    // browser. Letting Vite mark the tags keeps nonce coverage tied to the
    // bundler's own output shape instead of to regexes that have to guess it
    // (docs/specs/vscode.md → "CSP policy").
    cspNonce: CSP_NONCE_PLACEHOLDER,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname, "../lib"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "media"),
    emptyOutDir: true,
  },
});
