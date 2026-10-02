import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { required, cloudflare, hyperdriveOrigin, originsOf } from "./preview.mjs";
import { relaySmoke, smokeAll } from "./preview-smoke.mjs";
import {
  WORKERS,
  deployWorkers,
  fromStage,
  oauthProviders,
  readConfigs,
} from "./workers.mjs";

/**
 * Each Worker's production name and origin, pinned here so an edited config
 * cannot redirect production or stand in for a sibling.
 */
export const PRODUCTION = {
  account: { name: "dormouse-hosted", origin: "https://hosted.dormouse.sh" },
  relay: { name: "dormouse-relay", origin: "https://relay.dormouse.sh" },
  voice: { name: "dormouse-voice", origin: "https://voice.dormouse.sh" },
};

export function productionConfig(base, env, worker) {
  const identity = PRODUCTION[worker];
  assert.ok(identity, `Unknown Worker ${worker}`);
  assert.match(required(env, "BUILD_SHA"), /^[a-f0-9]{40}$/);
  assert.match(required(env, "CLOUDFLARE_ACCOUNT_ID"), /^[a-f0-9]{32}$/);
  assert.equal(base.name, identity.name);
  assert.equal(base.vars.APP_ORIGIN, identity.origin);
  // The relay's enrollment links name production's account, and only it.
  if (worker === "relay")
    assert.equal(base.vars.ACCOUNT_ORIGIN, PRODUCTION.account.origin);
  // The canonical domain alone: no public alias, candidate, or preview URL.
  assert.deepEqual(base.routes, [
    { pattern: new URL(identity.origin).host, custom_domain: true },
  ]);
  assert.equal(base.workers_dev, false);
  assert.equal(base.preview_urls, false);
  assert.deepEqual(base.observability, { enabled: false });
  const config = {
    ...base,
    main: fromStage(base.main),
    vars: { ...base.vars, BUILD_SHA: env.BUILD_SHA },
  };
  if (base.assets)
    config.assets = { ...base.assets, directory: fromStage(base.assets.directory) };
  if (base.hyperdrive) {
    assert.match(required(env, "HYPERDRIVE_ID"), /^[a-f0-9]{32}$/);
    assert.notEqual(
      env.HYPERDRIVE_ID,
      "0".repeat(32),
      "Provision production Hyperdrive first",
    );
    config.hyperdrive = base.hyperdrive.map(({ binding }) => ({
      binding,
      id: env.HYPERDRIVE_ID,
    }));
  }
  return config;
}

/** All three, keyed as `WORKERS` is. */
export function productionConfigs(bases, env) {
  return Object.fromEntries(
    Object.keys(WORKERS).map((worker) => [
      worker,
      productionConfig(bases[worker], env, worker),
    ]),
  );
}

/** The secret names each Worker that holds any must hold, by script. */
export function requiredSecrets(configs) {
  return Object.fromEntries(
    Object.entries(WORKERS)
      .filter(([, { secrets }]) => secrets)
      .map(([worker, { secrets }]) => [
        configs[worker].name,
        secrets(configs[worker]),
      ]),
  );
}
/**
 * The relay and voice retry as a preview's parts do, since a first release
 * attaches their custom domains and a new certificate can outlast the health
 * retry; the account's smoke sends POSTs, so it runs once.
 */
const ATTEMPTS = { account: 1, relay: 6, voice: 6 };

/**
 * Deploys relay, voice, then account, stopping at a failure. The relay passes
 * `relaySmoke` before anything after it deploys, so the account's `v2` deleting
 * the old `OneTimeRoom` never runs while the replacement is unproven.
 * `options` stands in for the process and network in tests.
 */
export function deployProduction(
  configs,
  sha,
  { stage = "production", spawn, ...options } = {},
) {
  return deployWorkers(stage, configs, {
    spawn,
    afterDeploy: async (worker) => {
      if (worker === "relay")
        await relaySmoke(configs.relay.vars.APP_ORIGIN, sha, {
          attempts: ATTEMPTS.relay,
          ...options,
        });
    },
  });
}

/** The release's live verification, of all three once the account deployed. */
export function productionSmoke(configs, sha, options = {}) {
  return smokeAll(originsOf(configs), sha, {
    providers: oauthProviders(configs.account),
    attempts: ATTEMPTS,
    ...options,
  });
}
export async function verifyPackages() {
  const commits = [];
  for (const name of ["pgstencil", "@pgstencil/auth/better-auth"]) {
    // Resolve the installed entrypoint, then read the provenance beside it.
    const entry = import.meta.resolve(name);
    const provenance = JSON.parse(
      await readFile(new URL("./provenance.json", entry), "utf8"),
    );
    assert.match(
      provenance.commit,
      /^[a-f0-9]{40}$/,
      "Production requires accepted, clean pgstencil provenance",
    );
    assert.notEqual(
      provenance.dirty,
      true,
      "Production requires accepted, clean pgstencil provenance",
    );
    commits.push(provenance.commit);
  }
  assert.equal(
    commits[0],
    commits[1],
    "Production requires accepted, clean pgstencil provenance",
  );
}
export async function preflight(env, configs, api = cloudflare(env)) {
  const origin = hyperdriveOrigin(required(env, "DATABASE_URL"));
  const { result } = await api(`hyperdrive/configs/${env.HYPERDRIVE_ID}`);
  assert.equal(
    result.caching?.disabled,
    true,
    "Production Hyperdrive must disable caching",
  );
  assert.equal(
    result.origin.host,
    origin.host,
    "Migration and runtime databases must use the same host",
  );
  assert.equal(
    result.origin.database,
    origin.database,
    "Migration and runtime databases must match",
  );
  assert.notEqual(
    result.origin.user,
    origin.user,
    "Use separate runtime and migration roles",
  );
  for (const [script, secrets] of Object.entries(requiredSecrets(configs))) {
    const { result: bindings } = await api(`workers/scripts/${script}/secrets`);
    const names = new Set(bindings.map((item) => item.name));
    for (const name of secrets)
      assert.ok(names.has(name), `Missing ${script} secret: ${name}`);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const configs = productionConfigs(await readConfigs(), process.env);
    const action = process.argv[2];
    if (action === "smoke") {
      await productionSmoke(configs, process.env.BUILD_SHA);
      console.log(
        "Hosted production revisions, auth boundary, and one-time rendezvous verified.",
      );
    } else if (action === "preflight" || action === "deploy") {
      await verifyPackages();
      await preflight(process.env, configs);
      if (action === "deploy")
        await deployProduction(configs, process.env.BUILD_SHA);
    } else throw new Error("Use preflight, deploy or smoke");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
