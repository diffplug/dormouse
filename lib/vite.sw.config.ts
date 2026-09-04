import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Pocket service worker, built separately from the app it serves
// (docs/specs/pocket-app.md -> Installable web app owns the rules;
// `lib/scripts/assert-pocket-worker.mjs` enforces them on the output).
//
// A second config rather than a second entry on `vite.pocket.config.ts`,
// because nothing about this output is an app asset: no content hash, no HTML
// shell, and no module syntax. Library mode already disables code splitting —
// which is why setting `inlineDynamicImports` here only earns a warning that it
// is redundant — so the IIFE format plus that default is what guarantees one
// self-contained file.
//
// Deliberately no `build.target`: this and the app config both take Vite's
// default, so the worker and the code it shares modules with compile to the
// same baseline.
export default defineConfig({
  resolve: {
    alias: {
      // Same unbuilt-`dist` problem the app config has: the worker imports the
      // shared security primitives, whose package `exports` point at a `dist`
      // this vite-only build never generates.
      "remote-lib-common": fileURLToPath(new URL("../remote-lib-common/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    // The app build owns clearing the directory; this one lands beside it.
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/remote/pocket-app/sw-entry.ts", import.meta.url)),
      // Classic worker: one self-contained script, no exports.
      formats: ["iife"],
      // Required by the IIFE format; nothing reads the global.
      name: "dormousePocketWorker",
      fileName: () => "sw.js",
    },
  },
});
