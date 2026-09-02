import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Pocket service worker, built separately from the app it serves
// (docs/specs/pocket-app.md -> Installable web app).
//
// A second config rather than a second entry on `vite.pocket.config.ts`,
// because everything about this output is unlike an app asset: no content hash
// (the browser needs one stable URL for the scope it controls), no HTML shell,
// and no module syntax at all — `registerPushServiceWorker` registers it
// classic, with no `type: 'module'`, so a top-level `import` or a dynamic-import
// loader would be a worker that fails to install on the phones that need it.
// Library mode already disables code splitting — which is why setting
// `inlineDynamicImports` here only earns a warning that it is redundant — so
// the IIFE format plus that default is what guarantees one self-contained file.
//
// It runs AFTER the app build with `emptyOutDir: false`, so the app's own
// `emptyOutDir: true` cannot wipe it. `lib/scripts/assert-pocket-worker.mjs`,
// the last step of `build:pocket`, is what holds every one of those properties.
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
      "server-lib-common": fileURLToPath(new URL("../server-lib-common/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    // The app build owns clearing the directory; this one lands beside it.
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/remote/pocket-app/sw.ts", import.meta.url)),
      // Classic worker: one self-contained script, no exports.
      formats: ["iife"],
      // Required by the IIFE format; nothing reads the global.
      name: "dormousePocketWorker",
      fileName: () => "sw.js",
    },
  },
});
