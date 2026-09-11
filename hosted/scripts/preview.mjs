import { createHmac } from "node:crypto";
import { readFile, writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function required(env, name) {
  if (!env[name]) throw new Error(`Missing ${name}; see hosted/DEPLOYMENT.md`);
  return env[name];
}

export function previewName(pr) {
  if (!/^[1-9]\d{0,8}$/.test(pr ?? ""))
    throw new Error("PR_NUMBER must be a positive integer");
  return `dormouse-hosted-pr-${pr}`;
}

export function previewConfig(base, env, hyperdriveId) {
  const name = previewName(env.PR_NUMBER);
  const subdomain = required(env, "CLOUDFLARE_WORKERS_SUBDOMAIN");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
    throw new Error(
      "Use the workers.dev subdomain only, without dots or a URL",
    );
  if (!/^[a-f0-9]{32}$/.test(hyperdriveId))
    throw new Error("Invalid Hyperdrive ID");
  if (!/^[a-f0-9]{40}$/.test(env.BUILD_SHA ?? ""))
    throw new Error("BUILD_SHA must be a commit SHA");
  // Deliberately allowlist fields: no production routes, bindings, or OAuth secrets.
  return {
    name,
    main: "../../server/preview-worker.ts",
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    assets: { ...base.assets, directory: "../../dist" },
    vars: {
      APP_ORIGIN: `https://${name}.${subdomain}.workers.dev`,
      BUILD_SHA: required(env, "BUILD_SHA"),
    },
    hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
  };
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

export async function prepare(env = process.env) {
  const name = previewName(env.PR_NUMBER);
  const base = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  const config = previewConfig(base, env, "0".repeat(32));
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
  config.hyperdrive[0].id = result.id;
  const directory = new URL("../.wrangler/preview/", import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    new URL("wrangler.json", directory),
    JSON.stringify(config, null, 2) + "\n",
  );
  await writeFile(new URL("secrets.json", directory), JSON.stringify(secrets), {
    mode: 0o600,
  });
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, `url=${config.vars.APP_ORIGIN}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `Preview target: ${config.vars.APP_ORIGIN}/login\n\nRevision: ${env.BUILD_SHA}\n\nCaptured email inbox: ${config.vars.APP_ORIGIN}/dev/emails. No real email is sent. Deployment and smoke checks must succeed below.\n`,
    );
  console.log(`Prepared ${config.vars.APP_ORIGIN}`);
}

export async function cleanup(env = process.env) {
  const name = previewName(env.PR_NUMBER);
  // Validate both providers before deleting anything, so a missing Neon token is caught first.
  required(env, "NEON_PROJECT_ID");
  required(env, "NEON_API_KEY");
  const api = cloudflare(env);
  await api(`workers/scripts/${name}`, "DELETE");
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
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "wrangler",
            "deploy",
            "--config",
            ".wrangler/preview/wrangler.json",
            "--secrets-file",
            ".wrangler/preview/secrets.json",
          ],
          {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            stdio: "inherit",
          },
        );
        process.exitCode = result.status ?? 1;
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
