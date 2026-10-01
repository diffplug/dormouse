import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  required,
  cloudflare,
  hyperdriveOrigin,
  readConfigs,
  WORKERS,
} from "./preview.mjs";
import { healthSmoke, smoke } from "./preview-smoke.mjs";
import { oneTimeSmoke } from "./one-time-smoke.mjs";
import { providerIds } from "../server/providers.js";

const root = new URL("../", import.meta.url);

/** Each Worker's production identity, which its checked-in config must match. */
export const PRODUCTION = {
  account: {
    name: "dormouse-hosted",
    origin: "https://hosted.dormouse.sh",
    main: "server/worker.ts",
    assets: "dist",
    hyperdrive: true,
  },
  relay: {
    name: "dormouse-relay",
    origin: "https://relay.dormouse.sh",
    main: "server/relay-worker.ts",
    assets: "dist-relay",
    hyperdrive: false,
  },
  voice: {
    name: "dormouse-voice",
    origin: "https://voice.dormouse.sh",
    main: "server/voice-worker.ts",
    hyperdrive: true,
  },
};

export function productionConfig(base, env, worker = "account") {
  const identity = PRODUCTION[worker];
  assert.match(required(env, "BUILD_SHA"), /^[a-f0-9]{40}$/);
  assert.match(required(env, "CLOUDFLARE_ACCOUNT_ID"), /^[a-f0-9]{32}$/);
  assert.equal(base.name, identity.name);
  assert.equal(base.main, identity.main);
  assert.equal(base.vars.APP_ORIGIN, identity.origin);
  // The canonical domain alone: no public alias, candidate, or preview URL.
  assert.deepEqual(base.routes, [
    { pattern: new URL(identity.origin).host, custom_domain: true },
  ]);
  assert.equal(base.workers_dev, false);
  assert.equal(base.preview_urls, false);
  assert.deepEqual(base.observability, { enabled: false });
  const config = {
    ...base,
    main: `../../${identity.main}`,
    vars: { ...base.vars, BUILD_SHA: env.BUILD_SHA },
  };
  if (identity.assets)
    config.assets = { ...base.assets, directory: `../../${identity.assets}` };
  else assert.equal(base.assets, undefined);
  if (identity.hyperdrive) {
    assert.match(required(env, "HYPERDRIVE_ID"), /^[a-f0-9]{32}$/);
    assert.notEqual(
      env.HYPERDRIVE_ID,
      "0".repeat(32),
      "Provision production Hyperdrive first",
    );
    config.hyperdrive = [{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID }];
  } else assert.equal(base.hyperdrive, undefined);
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

/** The secret names each Worker must hold, by script; the relay holds none. */
export function requiredSecrets(configs) {
  const account = ["AUTH_SECRET", "POSTMARK_SERVER_TOKEN"];
  for (const provider of configs.account.vars.OAUTH_PROVIDERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    assert.ok(providerIds.includes(provider), "Unknown OAuth provider");
    account.push(
      `${provider.toUpperCase()}_CLIENT_ID`,
      `${provider.toUpperCase()}_CLIENT_SECRET`,
    );
  }
  return {
    [configs.account.name]: account,
    [configs.relay.name]: [],
    [configs.voice.name]: ["ELEVENLABS_API_KEY"],
  };
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
    if (!secrets.length) continue;
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
      const sha = process.env.BUILD_SHA;
      await smoke(
        configs.account.vars.APP_ORIGIN,
        sha,
        fetch,
        false,
        configs.account.vars.OAUTH_PROVIDERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      await healthSmoke(configs.relay.vars.APP_ORIGIN, sha);
      await oneTimeSmoke(configs.relay.vars.APP_ORIGIN);
      await healthSmoke(configs.voice.vars.APP_ORIGIN, sha);
      console.log(
        "Hosted production revisions, auth boundary, and one-time rendezvous verified.",
      );
    } else if (action === "preflight" || action === "deploy") {
      await verifyPackages();
      await preflight(process.env, configs);
      if (action === "deploy") {
        const directory = new URL(".wrangler/production/", root);
        await mkdir(directory, { recursive: true });
        // Account, relay, voice; a failure stops the rest.
        for (const worker of Object.keys(WORKERS)) {
          const path = new URL(`wrangler.${worker}.json`, directory);
          await writeFile(
            path,
            JSON.stringify(configs[worker], null, 2) + "\n",
          );
          const run = spawnSync(
            "pnpm",
            ["exec", "wrangler", "deploy", "--config", fileURLToPath(path)],
            {
              cwd: fileURLToPath(root),
              stdio: "inherit",
            },
          );
          await rm(path, { force: true });
          assert.equal(run.status, 0, `${configs[worker].name} deploy failed`);
        }
      }
    } else throw new Error("Use preflight, deploy or smoke");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
