import { build } from "esbuild";
import { convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { WORKERS, parseConfig } from "../../scripts/workers.mjs";

interface WranglerConfig {
  main: string;
  vars: { APP_ORIGIN: string };
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

/** Hosted's three Wrangler configs, as the registry names them. */
export const wrangler = Object.fromEntries(
  Object.entries(WORKERS).map(([name, { config }]) => [
    name,
    parseConfig(readFileSync(config, "utf8")) as WranglerConfig,
  ]),
) as Record<keyof typeof WORKERS, WranglerConfig>;

export type Name = keyof typeof wrangler;
export const NAMES = Object.keys(wrangler) as Name[];
const each = <T>(pick: (config: WranglerConfig) => T) =>
  Object.fromEntries(NAMES.map((name) => [name, pick(wrangler[name])])) as Record<Name, T>;
/** Each Worker's production origin, from its config. */
export const ORIGINS = each((config) => config.vars.APP_ORIGIN);
/** The relay's `RELAY_ENROLL_SECRET` in every test; production's is a Worker secret. */
export const TEST_ENROLL_SECRET = "dormouse-hosted-test-enroll-secret";
/** Each Worker's production entry, from its config. */
export const ENTRIES = each((config) => config.main);

type V4Options = Parameters<typeof convertV4MiniflareOptions>[0];

/**
 * Miniflare options running `script` as Worker `name`: compatibility from
 * that Worker's own config, and its Durable Objects and rate limits bound as
 * the config declares them. `extra` adds the rest, and wins.
 */
export function miniflareOptions(name: Name, script: string, extra: Partial<V4Options> = {}) {
  const config = wrangler[name];
  return convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    ...(config.durable_objects && {
      durableObjects: Object.fromEntries(
        config.durable_objects.bindings.map(({ name, class_name }) => [
          name,
          {
            className: class_name,
            useSQLite: !!config.migrations?.some((migration) =>
              migration.new_sqlite_classes?.includes(class_name),
            ),
          },
        ]),
      ),
    }),
    ...(config.ratelimits && {
      ratelimits: Object.fromEntries(
        config.ratelimits.map(({ name, ...limit }) => [name, limit]),
      ),
    }),
    ...extra,
  } as V4Options);
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
