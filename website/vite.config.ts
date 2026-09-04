import { defineConfig, type Plugin } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

/**
 * Applies `public/_redirects` in dev, the way the host does in production.
 *
 * That file is a deploy artifact: Vite copies it into the build and never
 * reads it, so `/docs` — which exists only as a redirect — answered 404 on the
 * dev server while working everywhere else. The header's own **Docs** link
 * pointed at it, so the entrypoint's only feedback loop was production.
 *
 * Reads the file per request rather than at startup, so editing a rule takes
 * effect without a restart, and handles only the `3xx` rules — the `200`
 * rewrite is the SPA fallback, which the dev server already does.
 */
function redirectsInDev(): Plugin {
  return {
    name: "dormouse-redirects-in-dev",
    apply: "serve",
    configureServer(server) {
      const file = path.resolve(import.meta.dirname, "public/_redirects");
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (!url || !fs.existsSync(file)) return next();
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          const [from, to, status] = line.trim().split(/\s+/);
          if (!from || from.startsWith("#") || !to) continue;
          const code = Number(status);
          if (!Number.isInteger(code) || code < 300 || code > 399) continue;
          if (from !== url) continue;
          res.statusCode = code;
          res.setHeader("location", to);
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    mode === "test" ? null : reactRouter(),
    tailwindcss(),
    redirectsInDev(),
  ],
  resolve: {
    alias: {
      "dormouse-lib": path.resolve(import.meta.dirname, "../lib/src"),
      // The desktop playground bundles `Wall`, which pulls in the remote host
      // modules (`RemotePairingModalHost` → remote/burrow/*); those import
      // `remote-lib-common`, whose package `exports` resolve to a `dist` this
      // build never compiles. Alias it to source, exactly like `dormouse-lib`.
      "remote-lib-common": path.resolve(import.meta.dirname, "../remote-lib-common/src"),
      // Same story for `dor-lib-common`: `Wall` → `useDorControl` → `connect-port`
      // imports its `./agent-browser` subpath. The directory alias covers both
      // that subpath and the bare specifier.
      "dor-lib-common": path.resolve(import.meta.dirname, "../dor-lib-common/src"),
      // Wall also imports `dor/*` (protocol + command types); `dor` has no
      // package `exports`, and vite does not read tsconfig paths, so resolve it
      // to source — the same alias lib and standalone use.
      dor: path.resolve(import.meta.dirname, "../dor/src"),
      "ascii-splash-internal": path.resolve(
        import.meta.dirname,
        "node_modules/ascii-splash/dist",
      ),
      // ascii-splash's pattern registry statically imports PhotoPattern, which
      // statically imports `sharp`. The playground never builds a photo slot,
      // so keep the native module out of the bundle. See sharp-browser-stub.ts.
      sharp: path.resolve(import.meta.dirname, "src/lib/sharp-browser-stub.ts"),
      "@standalone-latest": path.resolve(
        import.meta.dirname,
        "public/standalone-latest.json",
      ),
    },
  },
  server: {
    host: true,
  },
  ssr: {
    // Bundle the xterm.js packages during SSR. Their package.json has
    // `main` (CJS) but no `exports` field, so Vite's SSR module runner
    // picks the CJS entry by default and `import { Terminal } from
    // "@xterm/xterm"` fails as a named-export error. Telling Vite to
    // bundle them forces it to use the `module` (ESM) entry instead.
    noExternal: ["@xterm/xterm", "@xterm/addon-fit"],
  },
}));
