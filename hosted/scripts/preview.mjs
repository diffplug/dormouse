import { createHmac } from "node:crypto";
import { readFile, writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function required(env, name) {
  if (!env[name])
    throw new Error(`Missing ${name}; see hosted/README.md -> Provision PR previews`);
  return env[name];
}

/** Hosted's three Workers, as their production config files and script names spell them. */
export const WORKERS = {
  account: { config: "wrangler.jsonc", script: "hosted" },
  relay: { config: "wrangler.relay.jsonc", script: "relay" },
  voice: { config: "wrangler.voice.jsonc", script: "voice" },
};

/** A PR's preview Worker, `dormouse-<script>-pr-N`; the account's name also names its Hyperdrive and Neon branch. */
export function previewName(pr, worker = "account") {
  if (!/^[1-9]\d{0,8}$/.test(pr ?? ""))
    throw new Error("PR_NUMBER must be a positive integer");
  return `dormouse-${WORKERS[worker].script}-pr-${pr}`;
}

/** The fields every preview Worker shares: its own workers.dev origin, and no production route. */
function previewBase(base, env, worker) {
  const name = previewName(env.PR_NUMBER, worker);
  const subdomain = required(env, "CLOUDFLARE_WORKERS_SUBDOMAIN");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
    throw new Error(
      "Use the workers.dev subdomain only, without dots or a URL",
    );
  if (!/^[a-f0-9]{40}$/.test(env.BUILD_SHA ?? ""))
    throw new Error("BUILD_SHA must be a commit SHA");
  return {
    name,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    vars: {
      APP_ORIGIN: `https://${name}.${subdomain}.workers.dev`,
      BUILD_SHA: required(env, "BUILD_SHA"),
    },
  };
}

function hyperdrive(hyperdriveId) {
  if (!/^[a-f0-9]{32}$/.test(hyperdriveId))
    throw new Error("Invalid Hyperdrive ID");
  return [{ binding: "HYPERDRIVE", id: hyperdriveId }];
}

// Each config deliberately allowlists fields: no production routes, bindings,
// triggers, or OAuth secrets.

/** The account preview: the inbox entry, and the account's append-only migrations. */
export function previewConfig(base, env, hyperdriveId) {
  return {
    ...previewBase(base, env, "account"),
    main: "../../server/preview-worker.ts",
    assets: { ...base.assets, directory: "../../dist" },
    hyperdrive: hyperdrive(hyperdriveId),
    migrations: base.migrations,
  };
}

/** The relay preview: the production relay entry, whose mapper passes nothing a preview lacks. */
export function relayPreviewConfig(base, env) {
  return {
    ...previewBase(base, env, "relay"),
    main: "../../server/relay-worker.ts",
    assets: { ...base.assets, directory: "../../dist-relay" },
    // A Durable Object namespace belongs to the Worker that implements it, so
    // the preview's is its own; rate-limit counters are account-wide, so the
    // preview's move to their own namespace ids.
    durable_objects: base.durable_objects,
    migrations: base.migrations,
    ratelimits: base.ratelimits?.map((limit) => ({
      ...limit,
      namespace_id: previewRatelimitNamespace(limit.namespace_id),
    })),
  };
}

/** The voice preview: the account preview's database, and no ElevenLabs key or cron. */
export function voicePreviewConfig(base, env, hyperdriveId) {
  return {
    ...previewBase(base, env, "voice"),
    main: "../../server/voice-preview-worker.ts",
    hyperdrive: hyperdrive(hyperdriveId),
  };
}

/** The three preview configs, keyed as `WORKERS` is. */
export function previewConfigs(bases, env, hyperdriveId) {
  return {
    account: previewConfig(bases.account, env, hyperdriveId),
    relay: relayPreviewConfig(bases.relay, env),
    voice: voicePreviewConfig(bases.voice, env, hyperdriveId),
  };
}

/** Each of Hosted's production configs, keyed as `WORKERS` is. */
export async function readConfigs() {
  const bases = {};
  for (const [worker, { config }] of Object.entries(WORKERS))
    bases[worker] = JSON.parse(
      await readFile(new URL(`../${config}`, import.meta.url), "utf8"),
    );
  return bases;
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

export async function findHyperdrives(api, name) {
  const matches = [];
  for (let page = 1; ; page++) {
    const data = await api(`hyperdrive/configs?per_page=100&page=${page}`);
    matches.push(...data.result.filter((item) => item.name === name));
    if (page >= (data.result_info?.total_pages ?? 1)) return matches;
  }
}

/** Where `prepare` writes each preview config, relative to `hosted/`. */
export const PREVIEW_CONFIG_PATHS = {
  account: ".wrangler/preview/wrangler.json",
  relay: ".wrangler/preview/wrangler.relay.json",
  voice: ".wrangler/preview/wrangler.voice.json",
};

export async function prepare(env = process.env) {
  const name = previewName(env.PR_NUMBER);
  const configs = previewConfigs(await readConfigs(), env, "0".repeat(32));
  const secret = required(env, "PREVIEW_AUTH_SECRET");
  if (secret.length < 32)
    throw new Error("PREVIEW_AUTH_SECRET needs at least 32 random characters");
  const secrets = {
    AUTH_SECRET: createHmac("sha256", secret).update(name).digest("hex"),
  };
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
  // The account and voice previews share the one Hyperdrive, as production does.
  configs.account.hyperdrive[0].id = result.id;
  configs.voice.hyperdrive[0].id = result.id;
  const directory = new URL("../.wrangler/preview/", import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [worker, path] of Object.entries(PREVIEW_CONFIG_PATHS))
    await writeFile(
      new URL(`../${path}`, import.meta.url),
      JSON.stringify(configs[worker], null, 2) + "\n",
    );
  await writeFile(new URL("secrets.json", directory), JSON.stringify(secrets), {
    mode: 0o600,
  });
  const origins = {
    account: configs.account.vars.APP_ORIGIN,
    relay: configs.relay.vars.APP_ORIGIN,
    voice: configs.voice.vars.APP_ORIGIN,
  };
  if (env.GITHUB_OUTPUT)
    await appendFile(
      env.GITHUB_OUTPUT,
      `url=${origins.account}\nrelay-url=${origins.relay}\nvoice-url=${origins.voice}\n`,
    );
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `Preview target: ${origins.account}/login\n\nOne-time page: ${origins.relay}/connect/\n\nVoice: ${origins.voice}\n\nRevision: ${env.BUILD_SHA}\n\nCaptured email inbox: ${origins.account}/dev/emails. No real email is sent. Deployment and smoke checks must succeed below.\n`,
    );
  console.log(`Prepared ${Object.values(origins).join(", ")}`);
}

export async function cleanup(env = process.env) {
  const name = previewName(env.PR_NUMBER);
  // Validate both providers before deleting anything, so a missing Neon token is caught first.
  required(env, "NEON_PROJECT_ID");
  required(env, "NEON_API_KEY");
  const api = cloudflare(env);
  // `force`: a Worker that implements a Durable Object namespace is deleted
  // with it rather than refused.
  for (const worker of Object.keys(WORKERS))
    await api(
      `workers/scripts/${previewName(env.PR_NUMBER, worker)}?force=true`,
      "DELETE",
    );
  for (const item of await findHyperdrives(api, name))
    await api(`hyperdrive/configs/${item.id}`, "DELETE");
  // The official create action reuses branches; cleanup must also tolerate retries.
  const project = encodeURIComponent(required(env, "NEON_PROJECT_ID"));
  const neon = async (path, method = "GET") => {
    const response = await fetch(
      `https://console.neon.tech/api/v2/projects/${project}/${path}`,
      {
        method,
        headers: { authorization: `Bearer ${required(env, "NEON_API_KEY")}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (method === "DELETE" && response.status === 404) return;
    if (!response.ok)
      throw new Error(`Neon ${method} failed (${response.status})`);
    return response.json();
  };
  let cursor;
  do {
    const data = await neon(
      `branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const branch of data.branches.filter((b) => b.name === name))
      await neon(`branches/${encodeURIComponent(branch.id)}`, "DELETE");
    cursor = data.pagination?.next;
  } while (cursor);
  console.log(`Removed preview resources for ${name}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const action = process.argv[2];
    if (action === "prepare") await prepare();
    else if (action === "cleanup") await cleanup();
    else if (action === "deploy") {
      await prepare();
      try {
        for (const [worker, path] of Object.entries(PREVIEW_CONFIG_PATHS)) {
          const result = spawnSync(
            "pnpm",
            [
              "exec",
              "wrangler",
              "deploy",
              "--config",
              path,
              // Only the account holds a secret.
              ...(worker === "account"
                ? ["--secrets-file", ".wrangler/preview/secrets.json"]
                : []),
            ],
            {
              cwd: fileURLToPath(new URL("../", import.meta.url)),
              stdio: "inherit",
            },
          );
          process.exitCode = result.status ?? 1;
          if (process.exitCode) break;
        }
      } finally {
        await rm(
          new URL("../.wrangler/preview/secrets.json", import.meta.url),
          { force: true },
        );
      }
    } else throw new Error("Use prepare, deploy or cleanup");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
