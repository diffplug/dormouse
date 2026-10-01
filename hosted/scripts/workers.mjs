import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { providerIds } from "../server/providers.js";

const hosted = new URL("../", import.meta.url);

/**
 * Hosted's three Workers, in deploy order, with the facts their Wrangler
 * configs do not carry. Everything else — script name, `main`, `APP_ORIGIN`,
 * assets, Hyperdrive, Durable Objects, rate limits — is read from `config`.
 * The account deploys last, so its `v2` deleting `OneTimeRoom` lands only once
 * the relay serving the replacement is deployed and, in production, smoked.
 */
export const WORKERS = {
  relay: {
    config: "wrangler.relay.jsonc",
    // The production entry: its mapper passes nothing a preview lacks.
    previewMain: "server/relay-worker.ts",
    secrets: () => ["RELAY_ENROLL_SECRET", "RELAY_VAPID_PUBLIC_KEY", "RELAY_VAPID_PRIVATE_KEY"],
    previewSecret: "RELAY_ENROLL_SECRET",
    /** Its preview also gets a VAPID pair, so push works with no production credential. */
    previewVapid: true,
  },
  voice: {
    config: "wrangler.voice.jsonc",
    previewMain: "server/voice-preview-worker.ts",
    secrets: () => ["ELEVENLABS_API_KEY"],
  },
  account: {
    config: "wrangler.jsonc",
    previewMain: "server/preview-worker.ts",
    /** The secret names its production Worker must hold. */
    secrets: (config) => [
      "AUTH_SECRET",
      "POSTMARK_SERVER_TOKEN",
      ...oauthProviders(config).flatMap((provider) => {
        assert.ok(providerIds.includes(provider), "Unknown OAuth provider");
        return [
          `${provider.toUpperCase()}_CLIENT_ID`,
          `${provider.toUpperCase()}_CLIENT_SECRET`,
        ];
      }),
    ],
    /** The one secret its preview is deployed with, derived from the preview secret. */
    previewSecret: "AUTH_SECRET",
  },
};

/** A Wrangler config: JSON, plus `//` comments on lines of their own. */
export const parseConfig = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

/** Each Worker's checked-in config, keyed as `WORKERS` is. */
export async function readConfigs() {
  const configs = {};
  for (const [worker, { config }] of Object.entries(WORKERS))
    configs[worker] = parseConfig(await readFile(new URL(config, hosted), "utf8"));
  return configs;
}

/** The OAuth providers a config enables, as `OAUTH_PROVIDERS` lists them. */
export function oauthProviders(config) {
  return (config.vars?.OAUTH_PROVIDERS ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
}

/**
 * A path in a checked-in config, relative to `hosted/`, as a config written
 * to `.wrangler/<stage>/` must spell it.
 */
export const fromStage = (path) => posix.join("../..", path);

/**
 * Writes each config to `.wrangler/<stage>/wrangler.<worker>.json` and deploys
 * them in `WORKERS` order, stopping at the first failure. `args` adds a
 * Worker's own flags; `afterDeploy(worker)` checks a deployed Worker before the
 * next deploys, and its failure stops the rest; `spawn` stands in for the
 * process in tests.
 */
export async function deployWorkers(
  stage,
  configs,
  { args = () => [], afterDeploy = async () => {}, spawn = spawnSync } = {},
) {
  const directory = new URL(`.wrangler/${stage}/`, hosted);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const worker of Object.keys(WORKERS)) {
    const path = new URL(`wrangler.${worker}.json`, directory);
    await writeFile(path, JSON.stringify(configs[worker], null, 2) + "\n");
    try {
      const run = spawn(
        "pnpm",
        ["exec", "wrangler", "deploy", "--config", fileURLToPath(path), ...args(worker)],
        { cwd: fileURLToPath(hosted), stdio: "inherit" },
      );
      if (run.status !== 0)
        throw new Error(`${configs[worker].name} deploy failed`);
    } finally {
      await rm(path, { force: true });
    }
    await afterDeploy(worker);
  }
}
