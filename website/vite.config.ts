import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [
    ...(process.env.VITEST ? [] : [reactRouter()]),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "mouseterm-lib": path.resolve(__dirname, "../lib/src"),
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
    noExternal: ["@xterm/xterm", "@xterm/addon-fit"],
  },
});
