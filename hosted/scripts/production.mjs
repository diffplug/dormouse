import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { required, cloudflare, hyperdriveOrigin } from "./preview.mjs";
import { smoke } from "./preview-smoke.mjs";

const root = new URL("../", import.meta.url);
export function productionConfig(base, env) {
  assert.match(required(env, "BUILD_SHA"), /^[a-f0-9]{40}$/);
  assert.match(required(env, "HYPERDRIVE_ID"), /^[a-f0-9]{32}$/);
  assert.notEqual(
    env.HYPERDRIVE_ID,
    "0".repeat(32),
    "Provision production Hyperdrive first",
  );
  assert.match(required(env, "CLOUDFLARE_ACCOUNT_ID"), /^[a-f0-9]{32}$/);
  assert.equal(base.name, "dormouse-hosted");
  assert.equal(base.vars.APP_ORIGIN, "https://hosted.dormouse.sh");
  assert.equal(base.workers_dev, false);
  assert.equal(base.preview_urls, false);
  return {
    ...base,
    main: "../../server/worker.ts",
    assets: { ...base.assets, directory: "../../dist" },
    vars: { ...base.vars, BUILD_SHA: env.BUILD_SHA },
    hyperdrive: [{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID }],
  };
}
export async function verifyPackages() {
  const manifest = JSON.parse(
    await readFile(new URL("../../vendor/build.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.dirty,
    false,
    "Production requires accepted, clean pgstencil provenance; refresh the vendored packages first",
  );
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    manifest.files.map((entry) => entry.filename).sort(),
    ["pgstencil-0.1.0.tgz", "pgstencil-auth-0.1.0.tgz"],
    "Expected both pinned pgstencil archives",
  );
  for (const entry of manifest.files) {
    assert.match(entry.filename, /^pgstencil(?:-auth)?-[\w.-]+\.tgz$/);
    const bytes = await readFile(
      new URL(`../../vendor/${entry.filename}`, import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      "Vendored archive checksum mismatch",
    );
  }
}
export async function preflight(env, config, api = cloudflare(env)) {
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
  const { result: bindings } = await api(
    "workers/scripts/dormouse-hosted/secrets",
  );
  const names = new Set(bindings.map((item) => item.name));
  const requiredSecrets = ["AUTH_SECRET", "POSTMARK_SERVER_TOKEN"];
  for (const provider of config.vars.OAUTH_PROVIDERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    assert.ok(
      ["github", "google", "microsoft", "apple"].includes(provider),
      "Unknown OAuth provider",
    );
    requiredSecrets.push(
      `${provider.toUpperCase()}_CLIENT_ID`,
      `${provider.toUpperCase()}_CLIENT_SECRET`,
    );
  }
  for (const name of requiredSecrets)
    assert.ok(names.has(name), `Missing Worker secret: ${name}`);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const base = JSON.parse(
      await readFile(new URL("wrangler.jsonc", root), "utf8"),
    );
    const config = productionConfig(base, process.env);
    const action = process.argv[2];
    if (action === "smoke") {
      await smoke(
        config.vars.APP_ORIGIN,
        process.env.BUILD_SHA,
        fetch,
        false,
        config.vars.OAUTH_PROVIDERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      console.log("Hosted production revision and auth boundary verified.");
    } else if (action === "preflight" || action === "deploy") {
      await verifyPackages();
      await preflight(process.env, config);
      if (action === "deploy") {
        const directory = new URL(".wrangler/production/", root);
        await mkdir(directory, { recursive: true });
        const path = new URL("wrangler.json", directory);
        await writeFile(path, JSON.stringify(config, null, 2) + "\n");
        const run = spawnSync(
          "pnpm",
          ["exec", "wrangler", "deploy", "--config", fileURLToPath(path)],
          {
            cwd: fileURLToPath(root),
            stdio: "inherit",
          },
        );
        await rm(path, { force: true });
        assert.equal(run.status, 0, "Hosted deploy failed");
      }
    } else throw new Error("Use preflight, deploy or smoke");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
