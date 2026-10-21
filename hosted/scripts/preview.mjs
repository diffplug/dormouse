import { createHmac } from "node:crypto";
import { writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { vapidKeysFrom } from "./vapid.mjs";
import { WORKERS, deployWorkers, fromStage, readConfigs } from "./workers.mjs";

export function required(env, name, section = "Provision PR previews") {
  if (!env[name])
    throw new Error(`Missing ${name}; see hosted/README.md -> ${section}`);
  return env[name];
}

/** A PR's preview of the production Worker `name`: `<name>-pr-N`. The account's also names its Hyperdrive and Neon branch. */
export function previewName(pr, name) {
  if (!/^[1-9]\d{0,8}$/.test(pr ?? ""))
    throw new Error("PR_NUMBER must be a positive integer");
  return `${name}-pr-${pr}`;
}

/**
 * A Worker's preview config, allowlisted from its production `base`: its own
 * workers.dev origin, its registry preview entry, assets rebased, its Durable
 * Objects with their migrations (a namespace belongs to the Worker implementing it),
 * rate limits in preview-only namespaces (counters are account-wide), and the
 * PR's Hyperdrive wherever the base binds one. Never routes, triggers, other
 * bindings, or production vars.
 */
export function previewConfig(base, env, worker, hyperdriveId) {
  const name = previewName(env.PR_NUMBER, base.name);
  const subdomain = required(env, "CLOUDFLARE_WORKERS_SUBDOMAIN");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
    throw new Error(
      "Use the workers.dev subdomain only, without dots or a URL",
    );
  if (!/^[a-f0-9]{40}$/.test(env.BUILD_SHA ?? ""))
    throw new Error("BUILD_SHA must be a commit SHA");
  const config = {
    name,
    main: fromStage(WORKERS[worker].previewMain),
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    vars: {
      APP_ORIGIN: `https://${name}.${subdomain}.workers.dev`,
      BUILD_SHA: env.BUILD_SHA,
    },
  };
  if (base.assets)
    config.assets = { ...base.assets, directory: fromStage(base.assets.directory) };
  if (base.hyperdrive) {
    if (!/^[a-f0-9]{32}$/.test(hyperdriveId))
      throw new Error("Invalid Hyperdrive ID");
    config.hyperdrive = base.hyperdrive.map(({ binding }) => ({
      binding,
      id: hyperdriveId,
    }));
  }
  // A binding to another Worker's class names that Worker's preview, never
  // production's. Migrations travel only with the Durable Objects a Worker
  // implements: one that implements none starts with none to delete.
  if (base.durable_objects) {
    const bindings = base.durable_objects.bindings.map((binding) =>
      binding.script_name
        ? { ...binding, script_name: previewName(env.PR_NUMBER, binding.script_name) }
        : binding,
    );
    config.durable_objects = { ...base.durable_objects, bindings };
    if (base.migrations && bindings.some((binding) => !binding.script_name))
      config.migrations = base.migrations;
  }
  if (base.ratelimits)
    config.ratelimits = base.ratelimits.map((limit) => ({
      ...limit,
      namespace_id: previewRatelimitNamespace(limit.namespace_id),
    }));
  return config;
}

/**
 * Every Worker's preview config, keyed as `WORKERS` is; all three share the
 * PR's one Hyperdrive, unlike production's one per Worker
 * (`docs/specs/hosted.md` -> "PR previews"). The relay's enrollment links name
 * the account preview, never production's account.
 */
export function previewConfigs(bases, env, hyperdriveId) {
  const configs = Object.fromEntries(
    Object.keys(WORKERS).map((worker) => [
      worker,
      previewConfig(bases[worker], env, worker, hyperdriveId),
    ]),
  );
  configs.relay.vars.ACCOUNT_ORIGIN = configs.account.vars.APP_ORIGIN;
  return configs;
}

/** Production rate-limit namespace ids stay below this; previews use id + offset. */
export const PREVIEW_RATELIMIT_OFFSET = 1000;

export function previewRatelimitNamespace(id) {
  const n = Number(id);
  if (!/^\d+$/.test(String(id)) || n <= 0 || n >= PREVIEW_RATELIMIT_OFFSET)
    throw new Error(
      `Rate-limit namespace_id ${id} must be a positive integer below ${PREVIEW_RATELIMIT_OFFSET}`,
    );
  return String(n + PREVIEW_RATELIMIT_OFFSET);
}

export function hyperdriveOrigin(connectionString) {
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.password ||
    !url.username
  )
    throw new Error("DATABASE_URL must be a direct Postgres connection URL");
  if (url.hostname.includes("-pooler."))
    throw new Error("Hyperdrive needs the direct Neon URL");
  // libpq and pg read these from the query too, so a URL setting one would
  // reach another database than the authority this answers.
  for (const key of ["host", "hostaddr", "port", "dbname", "user", "password", "service"])
    if (url.searchParams.has(key))
      throw new Error(`DATABASE_URL must not set ${key} in its query`);
  return {
    scheme: "postgres",
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function cloudflare(env, fetcher = fetch) {
  const account = required(env, "CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/.test(account))
    throw new Error("Invalid Cloudflare account ID");
  const token = required(env, "CLOUDFLARE_API_TOKEN");
  if (/\s|["']/.test(token))
    throw new Error(
      "CLOUDFLARE_API_TOKEN must contain only the token value, without whitespace, quotes, or a Bearer prefix",
    );
  return async (path, method = "GET", body) => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (method === "DELETE" && response.status === 404) return null;
    const data = await response.json();
    // Provider messages can contain credentials. Expose only numeric error codes.
    if (!response.ok || !data.success) {
      const codes = [];
      const collect = (errors) => {
        if (!Array.isArray(errors)) return;
        for (const error of errors) {
          if (Number.isSafeInteger(error?.code)) codes.push(error.code);
          collect(error?.error_chain);
        }
      };
      collect(data.errors);
      throw new Error(
        `Cloudflare ${method} ${path} failed (${response.status}; codes: ${codes.join(", ") || "none"})`,
      );
    }
    return data;
  };
}

async function listHyperdrives(api) {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await api(`hyperdrive/configs?per_page=100&page=${page}`);
    all.push(...data.result);
    if (page >= (data.result_info?.total_pages ?? 1)) return all;
  }
}

export const findHyperdrives = async (api, name) =>
  (await listHyperdrives(api)).filter((item) => item.name === name);

/** Where `prepare` leaves a preview Worker's secrets for `deploy`. */
const secretsFile = (worker) =>
  new URL(`../.wrangler/preview/secrets.${worker}.json`, import.meta.url);

/**
 * Each preview Worker's secrets, keyed as `WORKERS` is: its `previewSecret`,
 * the HMAC of `PREVIEW_AUTH_SECRET` with its preview Worker's name, so no two
 * Workers or PRs share one and none is stored; and, with `previewVapid`, a
 * VAPID pair derived the same way (`previewVapidKeys`).
 */
export function previewSecrets(configs, env) {
  const secret = required(env, "PREVIEW_AUTH_SECRET");
  if (secret.length < 32)
    throw new Error("PREVIEW_AUTH_SECRET needs at least 32 random characters");
  return Object.fromEntries(
    Object.entries(WORKERS)
      .filter(([, { previewSecret }]) => previewSecret)
      .map(([worker, { previewSecret, previewVapid }]) => {
        const name = configs[worker].name;
        return [
          worker,
          {
            [previewSecret]: createHmac("sha256", secret).update(name).digest("hex"),
            ...(previewVapid && previewVapidKeys(secret, name)),
          },
        ];
      }),
  );
}

/**
 * A preview's VAPID pair: the P-256 scalar is the HMAC of the preview secret
 * with `<name>/vapid`, so it is stable across a PR's redeploys and its
 * subscriptions survive them.
 */
export const previewVapidKeys = (secret, name) =>
  vapidKeysFrom((counter) =>
    createHmac("sha256", secret)
      .update(`${name}/vapid${counter ? `/${counter}` : ""}`)
      .digest(),
  );

/** Each Worker's origin in `configs`, keyed as `WORKERS` is. */
export const originsOf = (configs) =>
  Object.fromEntries(
    Object.entries(configs).map(([worker, config]) => [worker, config.vars.APP_ORIGIN]),
  );

/**
 * Validates every preview config, upserts the PR's Hyperdrive, writes each
 * Worker's secrets file, and emits the origins: `url` (the account's, for the
 * environment link) and `origins` (all three as JSON, for the smoke).
 */
export async function prepare(env = process.env) {
  const bases = await readConfigs();
  const name = previewName(env.PR_NUMBER, bases.account.name);
  // Every config and secret validates before any resource is created.
  const secrets = previewSecrets(previewConfigs(bases, env, "0".repeat(32)), env);
  const origin = hyperdriveOrigin(required(env, "DATABASE_URL"));
  const api = cloudflare(env);
  const matches = await findHyperdrives(api, name);
  if (matches.length > 1)
    throw new Error(`Multiple Hyperdrives named ${name}; remove duplicates`);
  const body = {
    name,
    origin,
    caching: { disabled: true },
    origin_connection_limit: 5,
  };
  const path = `hyperdrive/configs${matches[0] ? `/${matches[0].id}` : ""}`;
  const { result } = await api(path, matches[0] ? "PUT" : "POST", body);
  const configs = previewConfigs(bases, env, result.id);
  for (const [worker, values] of Object.entries(secrets)) {
    await mkdir(new URL("./", secretsFile(worker)), { recursive: true, mode: 0o700 });
    await writeFile(secretsFile(worker), JSON.stringify(values), { mode: 0o600 });
  }
  const origins = originsOf(configs);
  if (env.GITHUB_OUTPUT)
    await appendFile(
      env.GITHUB_OUTPUT,
      `url=${origins.account}\norigins=${JSON.stringify(origins)}\n`,
    );
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `Preview target: ${origins.account}/login\n\nOne-time page: ${origins.relay}/connect/\n\nVoice: ${origins.voice}\n\nRevision: ${env.BUILD_SHA}\n\nCaptured email inbox: ${origins.account}/dev/emails. No real email is sent. Deployment and smoke checks must succeed below.\n`,
    );
  console.log(`Prepared ${Object.values(origins).join(", ")}`);
  return configs;
}

/**
 * The preview Neon project's API. The official create action reuses branches,
 * so a DELETE tolerates retries.
 */
function neon(env) {
  const project = encodeURIComponent(required(env, "NEON_PROJECT_ID"));
  const key = required(env, "NEON_API_KEY");
  const call = async (path, method = "GET") => {
    const response = await fetch(
      `https://console.neon.tech/api/v2/projects/${project}/${path}`,
      {
        method,
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (method === "DELETE" && response.status === 404) return;
    if (!response.ok)
      throw new Error(`Neon ${method} failed (${response.status})`);
    return response.json();
  };
  call.branches = async () => {
    const all = [];
    let cursor;
    do {
      const data = await call(
        `branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      all.push(...data.branches);
      cursor = data.pagination?.next;
    } while (cursor);
    return all;
  };
  return call;
}

/** Production's Cloudflare account and Neon project (`hosted/README.md`), which no deletion here may target. */
export const PRODUCTION_IDS = ["0a95e814ccf2b6a95d2dc3bea0a4a2b4", "young-dust-56119072"];

function refuseProduction(env) {
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "NEON_PROJECT_ID"])
    if (PRODUCTION_IDS.includes(env[name]?.trim()))
      throw new Error(`${name} names production; preview cleanup refuses it`);
}

export async function cleanup(env = process.env) {
  refuseProduction(env);
  const bases = await readConfigs();
  const name = previewName(env.PR_NUMBER, bases.account.name);
  // Validate both providers before deleting anything, so a missing Neon token is caught first.
  const db = neon(env);
  const api = cloudflare(env);
  // `force`: a Worker that implements a Durable Object namespace is deleted
  // with it rather than refused.
  for (const base of Object.values(bases))
    await api(
      `workers/scripts/${previewName(env.PR_NUMBER, base.name)}?force=true`,
      "DELETE",
    );
  for (const item of await findHyperdrives(api, name))
    await api(`hyperdrive/configs/${item.id}`, "DELETE");
  for (const branch of await db.branches())
    if (branch.name === name)
      await db(`branches/${encodeURIComponent(branch.id)}`, "DELETE");
  console.log(`Removed preview resources for ${name}`);
}

/**
 * Cleans up every other PR's preview whose PR is closed or no longer labeled
 * `hosted-preview`, found by name among the preview account's Workers and
 * Hyperdrives and the preview project's branches. The deploy runs it first:
 * every job holding preview credentials waits on approval, so nothing cleans
 * up when a PR closes.
 */
export async function sweep(env = process.env) {
  refuseProduction(env);
  const bases = await readConfigs();
  // Validates the one PR a sweep never touches: the deploy's own.
  previewName(env.PR_NUMBER, bases.account.name);
  const repository = required(env, "GITHUB_REPOSITORY");
  const token = required(env, "GH_TOKEN");
  const db = neon(env);
  const api = cloudflare(env);
  const names = [
    ...(await api("workers/scripts")).result.map((script) => script.id),
    ...(await listHyperdrives(api)).map((item) => item.name),
    ...(await db.branches()).map((branch) => branch.name),
  ];
  const prs = new Set();
  for (const name of names)
    for (const base of Object.values(bases)) {
      const pr = name.startsWith(`${base.name}-pr-`) && name.slice(base.name.length + 4);
      if (pr && /^[1-9]\d{0,8}$/.test(pr) && pr !== env.PR_NUMBER) prs.add(pr);
    }
  for (const pr of [...prs].sort((a, b) => a - b)) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/pulls/${pr}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub pull ${pr} lookup failed (${response.status})`);
    const pull = await response.json();
    if (pull.state === "open" && pull.labels.some((label) => label.name === "hosted-preview"))
      continue;
    await cleanup({ ...env, PR_NUMBER: pr });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const action = process.argv[2];
    if (action === "prepare") await prepare();
    else if (action === "cleanup") await cleanup();
    else if (action === "sweep") await sweep();
    else if (action === "deploy") {
      const configs = await prepare();
      try {
        await deployWorkers("preview", configs, {
          args: (worker) =>
            WORKERS[worker].previewSecret
              ? ["--secrets-file", fileURLToPath(secretsFile(worker))]
              : [],
        });
      } finally {
        for (const worker of Object.keys(WORKERS))
          await rm(secretsFile(worker), { force: true });
      }
    } else throw new Error("Use prepare, deploy, cleanup or sweep");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
