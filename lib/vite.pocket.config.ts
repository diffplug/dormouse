import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import swConfig from "./vite.sw.config";

/**
 * Serve the worker from source while `dev:pocket` is running.
 *
 * The worker is bundled, not copied (docs/specs/pocket-app.md -> Installable
 * web app), so `publicDir` no longer has a file to hand out — and a dev server
 * that 404s it would leave push untestable on the one command a developer
 * actually runs. This bundles the same `vite.sw.config.ts` in memory per
 * request: once per page load, and always the code the production build would
 * emit rather than a dev-only stand-in.
 */
function serveWorkerFromSource(): Plugin {
  // The one name `registerPushServiceWorker` asks for, read off the build that
  // owns it rather than spelled a second time.
  const fileName = (swConfig.build as { lib: { fileName: () => string } }).lib.fileName;
  const workerPath = `/${fileName()}`;
  return {
    name: "dormouse-pocket-sw-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== workerPath) return next();
        try {
          const result = await build({
            ...swConfig,
            configFile: false,
            logLevel: "warn",
            build: { ...swConfig.build, write: false },
          });
          // Narrowed locally: the bundler's own output types resolve through
          // `vite`'s dependency, which this package does not declare.
          type Emitted = { output: Array<{ type: string; code?: string }> };
          const [bundle] = (Array.isArray(result) ? result : [result]) as Emitted[];
          const chunk = bundle?.output.find((entry) => entry.type === "chunk");
          if (!chunk?.code) throw new Error("the worker build emitted no chunk");
          res.setHeader("content-type", "text/javascript");
          // Registration re-fetches on every load; a cached dev worker would
          // outlive the edit that motivated the reload.
          res.setHeader("cache-control", "no-store");
          res.end(chunk.code);
        } catch (error: unknown) {
          server.config.logger.error(`failed to build ${workerPath}: ${String(error)}`);
          res.statusCode = 500;
          res.end("// the Pocket worker failed to build; see the dev server log\n");
        }
      });
    },
  };
}

// Second entry, separate from the main `lib` app (index.html): the standalone
// Pocket phone web app. Its HTML lives in `pocket/index.html` and pulls in
// `src/remote/pocket-app/main.tsx`; the build lands in `dist-pocket/` for the
// server to serve statically (docs/specs/pocket-app.md). It shares the full
// terminal UI (`MobileTerminalUi`/`MobileWall`) and the themeable design
// system with the main app, so it needs the same Tailwind + `--vscode-*`
// theme plumbing (`src/index.css`); the HTML shell carries the structural
// viewport rules inline.
export default defineConfig({
  plugins: [react(), tailwindcss(), serveWorkerFromSource()],
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
      // `dor-lib-common` has the same unbuilt-`dist` exports problem, reached via
      // `Wall` → `useDorControl` → `connect-port`.
      "dor-lib-common": fileURLToPath(new URL("../dor-lib-common/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pocket", import.meta.url)),
    emptyOutDir: true,
  },
});
