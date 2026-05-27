import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

/**
 * Builds the lib frontend for embedding in the VSCode extension webview.
 * Output goes to vscode-ext/media/ which the extension serves as a webview.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(__dirname, "../lib"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "media"),
    emptyOutDir: true,
  },
});
