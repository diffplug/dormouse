import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  plugins: [
    mode === "test" ? null : reactRouter(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "dormouse-lib": path.resolve(__dirname, "../lib/src"),
      // The desktop playground bundles `Wall`, which pulls in the remote host
      // modules (`RemotePairingModalHost` → remote/host/*); those import
      // `server-lib-common`, whose package `exports` resolve to a `dist` this
      // build never compiles. Alias it to source, exactly like `dormouse-lib`.
      "server-lib-common": path.resolve(__dirname, "../server-lib-common/src"),
      "ascii-splash-internal": path.resolve(
        __dirname,
        "node_modules/ascii-splash/dist",
      ),
      "@standalone-latest": path.resolve(
        __dirname,
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
