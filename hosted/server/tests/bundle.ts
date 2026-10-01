import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

interface WranglerConfig {
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  ratelimits?: {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: 10 | 60 };
  }[];
}

/** Hosted's three Wrangler configs, which are strict JSON so scripts can parse them. */
export const wrangler = {
  account: read("wrangler.jsonc"),
  relay: read("wrangler.relay.jsonc"),
  voice: read("wrangler.voice.jsonc"),
};

function read(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as WranglerConfig;
}

/** A Worker entry bundled for workerd the way Wrangler bundles it. */
export function bundleWorker(entry: string, inject: string[] = []) {
  return build({
    entryPoints: [entry],
    inject,
    bundle: true,
    write: false,
    metafile: true,
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
