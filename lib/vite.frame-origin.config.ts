import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";

// What a frame origin serves (docs/specs/pocket-app.md -> scope pocket-frames):
// a worker at the origin root and a bootstrap page. One classic script each, so
// one config run per script: library mode takes a single IIFE entry, `--mode`
// picks it, and only the worker's run clears the directory.
const ENTRIES = {
  worker: { entry: "./src/remote/frame-origin/worker-entry.ts", file: "__dormouse-frame-sw.js" },
  bootstrap: { entry: "./src/remote/frame-origin/bootstrap.ts", file: "__dormouse-frame/bootstrap.js" },
} as const;

export default defineConfig(({ mode }) => {
  const output = mode === "bootstrap" ? ENTRIES.bootstrap : ENTRIES.worker;
  return {
    resolve: { alias: workspaceSourceAliases() },
    publicDir: fileURLToPath(new URL("./frame-origin-public", import.meta.url)),
    build: {
      outDir: fileURLToPath(new URL("./dist-frame-origin", import.meta.url)),
      emptyOutDir: mode !== "bootstrap",
      lib: {
        entry: fileURLToPath(new URL(output.entry, import.meta.url)),
        formats: ["iife"],
        name: "dormouseFrameOrigin",
        fileName: () => output.file,
      },
    },
  };
});
