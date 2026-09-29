import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

/** `hosted/wrangler.jsonc`, which is strict JSON so scripts can parse it. */
export const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  ratelimits: {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: 10 | 60 };
  }[];
};

/** A Worker entry bundled for workerd the way Wrangler bundles it. */
export function bundleWorker(entry: string, inject: string[] = []) {
  return build({
    entryPoints: [entry],
    inject,
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker"],
    external: ["node:*", "cloudflare:*"],
    alias: Object.fromEntries(
      builtinModules
        .filter((name) => !name.startsWith("node:"))
        .map((name) => [name, `node:${name}`]),
    ),
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');",
    },
  });
}
