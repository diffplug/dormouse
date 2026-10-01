import { build } from "esbuild";
import { convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { WORKERS, parseConfig } from "../../scripts/workers.mjs";

interface WranglerConfig {
  name: string;
  main: string;
  vars: { APP_ORIGIN: string };
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects?: {
    bindings: { name: string; class_name: string; script_name?: string }[];
  };
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

/** Whether the Worker that implements `className` (`script`, or `config`'s own) made it SQLite-backed. */
function sqliteClass(config: WranglerConfig, className: string, script?: string) {
  const owner = script ? Object.values(wrangler).find((worker) => worker.name === script)! : config;
  return !!owner.migrations?.some((migration) =>
    migration.new_sqlite_classes?.includes(className),
  );
}

/**
 * Miniflare options running `script` as Worker `name`, under its config's
 * script name: compatibility from that Worker's own config, and its Durable
 * Objects — another Worker's by that Worker's script name — and rate limits
 * bound as the config declares them. `extra` adds the rest, and wins. A
 * Worker binding another's class runs in one Miniflare beside it, real or
 * {@link relayStandIn}.
 */
export function miniflareOptions(name: Name, script: string, extra: Partial<V4Options> = {}) {
  const config = wrangler[name];
  return convertV4MiniflareOptions({
    name: config.name,
    modules: true,
    script,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    ...(config.durable_objects && {
      durableObjects: Object.fromEntries(
        config.durable_objects.bindings.map(({ name, class_name, script_name }) => [
          name,
          {
            className: class_name,
            ...(script_name && { scriptName: script_name }),
            useSQLite: sqliteClass(config, class_name, script_name),
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

/**
 * The relay Worker as a Worker binding its `RelayRoom` sees it, where the
 * test needs no real relay: a `RelayRoom` whose RPC methods report nothing.
 */
export function relayStandIn() {
  return miniflareOptions(
    "relay",
    `import { DurableObject } from "cloudflare:workers";
    export class OneTimeRoom extends DurableObject {}
    export class RelayRoom extends DurableObject {
      async closeBurrow() { return false; }
      async onlineBurrows() { return []; }
    }
    export default { fetch: () => new Response(null, { status: 404 }) };`,
  );
}

type Options = ReturnType<typeof miniflareOptions>;

/** One Miniflare running `main` — which `dispatchFetch` reaches unless a route says otherwise — and `siblings`. */
export function together(main: Options, ...siblings: Options[]): Options {
  return { ...main, workers: [...main.workers, ...siblings.flatMap((sibling) => sibling.workers)] };
}

/** `options` for Worker `name`, beside the relay stand-in when it binds the relay's `RelayRoom`. */
export function alone(name: Name, options: Options): Options {
  return name === "account" ? together(options, relayStandIn()) : options;
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
