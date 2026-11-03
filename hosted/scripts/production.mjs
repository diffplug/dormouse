import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { required, cloudflare, hyperdriveOrigin, originsOf } from "./preview.mjs";
import { trySmoke, frameSmoke, relaySmoke, smokeAll } from "./preview-smoke.mjs";
import { HOSTED_FRAME_DOMAIN } from "../../remote-lib-common/src/remote/pocket-deployment.ts";
import {
  WORKERS,
  deployWorkers,
  fromStage,
  oauthProviders,
  readConfigs,
} from "./workers.mjs";

/**
 * Each Worker's production name and origin, pinned here so an edited config
 * cannot redirect production or stand in for a sibling, and its Hyperdrive:
 * the GitHub variable naming it and the Postgres role it must connect as —
 * the relay's and voice's created by `hosted/server/runtime-roles.sql`, the
 * account's by hand (hosted/README.md). The try Worker has none.
 */
export const PRODUCTION = {
  account: {
    name: "dormouse-hosted",
    origin: "https://hosted.dormouse.sh",
    hyperdrive: "HYPERDRIVE_ID",
    role: "dormouse_app",
  },
  relay: {
    name: "dormouse-relay",
    origin: "https://relay.dormouse.sh",
    hyperdrive: "RELAY_HYPERDRIVE_ID",
    role: "dormouse_relay",
  },
  voice: {
    name: "dormouse-voice",
    origin: "https://voice.dormouse.sh",
    hyperdrive: "VOICE_HYPERDRIVE_ID",
    role: "dormouse_voice",
  },
  try: {
    name: "dormouse-try",
    origin: "https://try.dormouse.sh",
  },
};

/** The Workers `PRODUCTION` gives a Hyperdrive and a role. */
const hyperdriveWorkers = Object.entries(PRODUCTION).filter(([, { hyperdrive }]) => hyperdrive);

/** The frame Worker's identity, on a domain nothing else of Hosted's is under. */
export const FRAMES = {
  name: "dormouse-frames",
  domain: HOSTED_FRAME_DOMAIN,
  clientOrigins: `${PRODUCTION.relay.origin} ${PRODUCTION.try.origin}`,
};

/** Its whole config: anything more, a binding above all, it must not have. */
const FRAMES_CONFIG_KEYS = new Set([
  "$schema", "name", "main", "compatibility_date", "workers_dev", "preview_urls",
  "routes", "assets", "vars", "observability",
]);

/** A production variable or secret, or an error naming it. */
const need = (env, name) => required(env, name, "Deployment credentials in GitHub");

function framesConfig(base) {
  assert.equal(base.name, FRAMES.name);
  for (const key of Object.keys(base))
    assert.ok(FRAMES_CONFIG_KEYS.has(key), `${FRAMES.name} must not carry ${key}`);
  assert.deepEqual(base.vars, { CLIENT_ORIGINS: FRAMES.clientOrigins });
  assert.deepEqual(base.routes, [{ pattern: `*.${FRAMES.domain}/*`, zone_name: FRAMES.domain }]);
  assert.equal(base.assets.binding, "ASSETS");
  assert.equal(base.workers_dev, false);
  assert.equal(base.preview_urls, false);
  assert.deepEqual(base.observability, { enabled: false });
  return {
    ...base,
    main: fromStage(base.main),
    assets: { ...base.assets, directory: fromStage(base.assets.directory) },
  };
}

export function productionConfig(base, env, worker) {
  if (worker === "frames") return framesConfig(base);
  const identity = PRODUCTION[worker];
  assert.ok(identity, `Unknown Worker ${worker}`);
  assert.match(need(env, "BUILD_SHA"), /^[a-f0-9]{40}$/);
  assert.match(need(env, "CLOUDFLARE_ACCOUNT_ID"), /^[a-f0-9]{32}$/);
  assert.equal(base.name, identity.name);
  assert.equal(base.vars.APP_ORIGIN, identity.origin);
  // The relay's enrollment links name production's account, and only it, and
  // an older build's one-time link moves to production's page, and only it.
  if (worker === "relay") {
    assert.equal(base.vars.ACCOUNT_ORIGIN, PRODUCTION.account.origin);
    assert.equal(base.vars.TRY_ORIGIN, PRODUCTION.try.origin);
  }
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
  const variable = identity.hyperdrive;
  if (!variable) {
    assert.equal(base.hyperdrive, undefined, `${identity.name} must not bind a Hyperdrive`);
    return config;
  }
  const id = need(env, variable);
  assert.match(id, /^[a-f0-9]{32}$/, `${variable} must be a Hyperdrive ID`);
  assert.notEqual(id, "0".repeat(32), `Provision production Hyperdrive first: ${variable}`);
  config.hyperdrive = (base.hyperdrive ?? []).map(({ binding }) => ({ binding, id }));
  return config;
}

/**
 * Each Worker's Hyperdrive ID, keyed as `PRODUCTION` is: an error unless every
 * Worker binds exactly one and no two bind the same.
 */
function hyperdriveIds(configs) {
  const ids = Object.fromEntries(
    hyperdriveWorkers.map(([worker]) => {
      const bindings = configs[worker].hyperdrive ?? [];
      assert.equal(
        bindings.length,
        1,
        `${configs[worker].name} must bind exactly one Hyperdrive`,
      );
      return [worker, bindings[0].id];
    }),
  );
  const variables = hyperdriveWorkers.map(([, { hyperdrive }]) => hyperdrive);
  assert.equal(
    new Set(Object.values(ids)).size,
    variables.length,
    `${variables.join(", ")} must name three different Hyperdrives`,
  );
  return ids;
}

/** All of them, keyed as `WORKERS` is, each that binds one on its own Hyperdrive. */
export function productionConfigs(bases, env) {
  const configs = Object.fromEntries(
    Object.keys(WORKERS).map((worker) => [
      worker,
      productionConfig(bases[worker], env, worker),
    ]),
  );
  hyperdriveIds(configs);
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
 * The relay, voice, and try Workers retry as a preview's parts do, since a
 * first release attaches their custom domains and a new certificate can outlast
 * the health retry; the account's smoke sends POSTs, so it runs once.
 */
const ATTEMPTS = { account: 1, relay: 6, voice: 6, try: 6 };

/**
 * Deploys frames, try, relay, voice, then account, stopping at a failure.
 * The try Worker passes `trySmoke` before the relay deploys, so a link
 * an older build shows is never redirected to a page not yet served, and the
 * relay passes `relaySmoke` before anything after it deploys.
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
      if (worker === "frames")
        await frameSmoke(FRAMES.domain, FRAMES.clientOrigins, { attempts: ATTEMPTS.relay, ...options });
      if (worker === "try")
        await trySmoke(configs.try.vars.APP_ORIGIN, sha, {
          attempts: ATTEMPTS.try,
          ...options,
        });
      if (worker === "relay")
        await relaySmoke(configs.relay.vars.APP_ORIGIN, configs.try.vars.APP_ORIGIN, sha, {
          attempts: ATTEMPTS.relay,
          ...options,
        });
    },
  });
}

/** The release's live verification, of all of them once the account deployed. */
export async function productionSmoke(configs, sha, options = {}) {
  await frameSmoke(FRAMES.domain, FRAMES.clientOrigins, { attempts: ATTEMPTS.relay, ...options });
  return smokeAll(originsOf(configs), sha, {
    providers: oauthProviders(configs.account),
    attempts: ATTEMPTS,
    ...options,
  });
}
/** Each pgstencil package Hosted installs, by an entrypoint beside its `dist/provenance.json`. */
const PGSTENCIL_PACKAGES = ["pgstencil", "@pgstencil/auth/better-auth", "@pgstencil/stripe"];
/** The installed package's `dist/provenance.json`, read beside its resolved entrypoint. */
const installedProvenance = (name) =>
  readFile(new URL("./provenance.json", import.meta.resolve(name)), "utf8");
export async function verifyPackages(readProvenance = installedProvenance) {
  const commits = [];
  for (const name of PGSTENCIL_PACKAGES) {
    const provenance = JSON.parse(await readProvenance(name));
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
  assert.ok(
    commits.every((commit) => commit === commits[0]),
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
  const ids = hyperdriveIds(configs);
  const origin = hyperdriveOrigin(need(env, "DATABASE_URL"));
  for (const [worker, { role }] of hyperdriveWorkers) {
    const { result } = await api(`hyperdrive/configs/${ids[worker]}`);
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
    assert.equal(result.origin.user, role, `${name} must connect as ${role}`);
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
