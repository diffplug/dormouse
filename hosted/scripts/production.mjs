import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
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

/**
 * Each Worker's production Hyperdrive: the GitHub variable naming it, and the
 * Postgres role it must connect as — the relay's and voice's created by
 * `hosted/server/runtime-roles.sql`, the account's by hand (hosted/README.md).
 */
export const HYPERDRIVES = {
  account: { variable: "HYPERDRIVE_ID", user: "dormouse_app" },
  relay: { variable: "RELAY_HYPERDRIVE_ID", user: "dormouse_relay" },
  voice: { variable: "VOICE_HYPERDRIVE_ID", user: "dormouse_voice" },
};

/** A production variable or secret, or an error naming it. */
const need = (env, name) => required(env, name, "Deployment credentials in GitHub");

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
    const { variable } = HYPERDRIVES[worker];
    const id = need(env, variable);
    assert.match(id, /^[a-f0-9]{32}$/, `${variable} must be a Hyperdrive ID`);
    assert.notEqual(id, "0".repeat(32), `Provision production Hyperdrive first: ${variable}`);
    config.hyperdrive = base.hyperdrive.map(({ binding }) => ({ binding, id }));
  }
  return config;
}

/** All three, keyed as `WORKERS` is, each on its own Hyperdrive. */
export function productionConfigs(bases, env) {
  const configs = Object.fromEntries(
    Object.keys(WORKERS).map((worker) => [
      worker,
      productionConfig(bases[worker], env, worker),
    ]),
  );
  const variables = Object.values(HYPERDRIVES).map(({ variable }) => variable);
  assert.equal(
    new Set(variables.map((variable) => env[variable])).size,
    variables.length,
    `${variables.join(", ")} must name three different Hyperdrives`,
  );
  return configs;
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
/**
 * Before the backup, so a release whose Cloudflare or Postgres side is not
 * ready changes nothing: each Worker's Hyperdrive is uncached, reaches the
 * migration URL's host, port, and database, and connects as that Worker's own
 * role, never the migration role; and each Worker holds its secrets.
 */
export async function preflight(env, configs, api = cloudflare(env)) {
  const origin = hyperdriveOrigin(need(env, "DATABASE_URL"));
  for (const [worker, { user }] of Object.entries(HYPERDRIVES))
    for (const { id } of configs[worker].hyperdrive) {
      const { result } = await api(`hyperdrive/configs/${id}`);
      const name = `${configs[worker].name}'s Hyperdrive`;
      assert.equal(result.caching?.disabled, true, `${name} must disable caching`);
      assert.equal(
        result.origin.host,
        origin.host,
        `${name} must use the migration database's host`,
      );
      assert.equal(
        Number(result.origin.port),
        origin.port,
        `${name} must use the migration database's port`,
      );
      assert.equal(
        result.origin.database,
        origin.database,
        `${name} must use the migration database`,
      );
      assert.notEqual(
        result.origin.user,
        origin.user,
        `${name} must not connect as the migration role`,
      );
      assert.equal(result.origin.user, user, `${name} must connect as ${user}`);
    }
  for (const [script, secrets] of Object.entries(requiredSecrets(configs))) {
    const { result: bindings } = await api(`workers/scripts/${script}/secrets`);
    const names = new Set(bindings.map((item) => item.name));
    for (const name of secrets)
      assert.ok(names.has(name), `Missing ${script} secret: ${name}`);
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const configs = productionConfigs(await readConfigs(), process.env);
    const action = process.argv[2];
    if (action === "smoke") {
      await productionSmoke(configs, process.env.BUILD_SHA);
      console.log(
        "Hosted production revisions, readiness, auth boundary, and one-time rendezvous verified.",
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
