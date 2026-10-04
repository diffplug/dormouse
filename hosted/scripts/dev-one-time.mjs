import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ONE_TIME_BASE } from "../../lib/scripts/assert-pocket-worker.mjs";
import { parseConfig } from "./workers.mjs";

/**
 * The one-time rendezvous and phone page on loopback (`docs/specs/one-time.md`
 * -> "Dev loop"): the relay Worker under `wrangler dev`, with its Durable
 * Object and rate limits, serving the page `vite build --watch` rebuilds. Root `pnpm dev:one-time`; inside Dormouse, `dor tool
 * one-time`. A loopback bind is not an access control, and this needs none of
 * its own: the Worker's origin gate refuses any Host but the loopback origin,
 * and the routes' Origin rules are the deployed ones.
 */

const hosted = fileURLToPath(new URL("../", import.meta.url));
const lib = fileURLToPath(new URL("../../lib/", import.meta.url));
/** Under `.wrangler/`, which is Wrangler's own and ignored. */
const devDir = resolve(hosted, ".wrangler/one-time-dev");
/** The page path, as `lib`'s build names it and the Worker serves it. */
const PAGE_PATH = ONE_TIME_BASE;

const children = [];
let stopping = false;
/** Stop both children and exit with `code` once they have gone. */
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

/** Fixed rather than OS-assigned: the origin is baked into the Burrow build that dials it. */
export const DEFAULT_PORT = 8787;

/** The port `PORT` names, or the default; anything else is refused before a process starts. */
export function devPort(env) {
  if (env.PORT === undefined || env.PORT === "") return DEFAULT_PORT;
  const port = Number(env.PORT);
  if (!/^\d+$/.test(env.PORT) || port < 1 || port > 65535)
    throw new Error(`PORT must be a TCP port, not ${JSON.stringify(env.PORT)}`);
  return port;
}

/**
 * The loopback origin, as `localhost`: the host a Dor Tool frames and
 * `dor agent-browser` opens, and one the link grammar admits over plain HTTP.
 */
export function devOrigin(port) {
  return `http://localhost:${port}`;
}

/** The loop's `RELAY_ENROLL_SECRET`: user codes need one, and nothing here is secret. */
export const DEV_ENROLL_SECRET = "dormouse-relay-local-development-only";

/**
 * The Hosted dev loop this run is part of, or null on its own: `pnpm
 * dev:hosted` starts this script with the account origin that approves codes
 * and its development database, so device-code sign-in redeems locally. Both
 * or neither.
 */
export function hostedAttachment(env) {
  const accountOrigin = env.HOSTED_DEV_ACCOUNT_ORIGIN || undefined;
  const databaseUrl = env.HOSTED_DEV_DATABASE_URL || undefined;
  if (!accountOrigin && !databaseUrl) return null;
  if (!accountOrigin || !databaseUrl)
    throw new Error("HOSTED_DEV_ACCOUNT_ORIGIN and HOSTED_DEV_DATABASE_URL are set together.");
  return { accountOrigin, databaseUrl };
}

/**
 * The Wrangler config the loop runs, written beside the staged page.
 * Allowlisted from `hosted/wrangler.relay.jsonc` like the preview's: the relay
 * entry, the rendezvous's Durable Object, migration, and rate limits, and the
 * assets binding over the staging folder — never a route or a production
 * secret, so it cannot answer for production. Its enrollment secret is
 * {@link DEV_ENROLL_SECRET}, fixed and public. Attached to the Hosted dev loop
 * ({@link hostedAttachment}), it also names that account origin and reaches
 * its database through a local Hyperdrive, never production's.
 */
export function devConfig(base, port, attached = null) {
  return {
    name: `${base.name}-dev`,
    main: "../../server/relay-worker.ts",
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    assets: { ...base.assets, directory: "./assets" },
    vars: {
      APP_ORIGIN: devOrigin(port),
      RELAY_ENROLL_SECRET: DEV_ENROLL_SECRET,
      ...(attached && { ACCOUNT_ORIGIN: attached.accountOrigin }),
    },
    ...(attached && {
      hyperdrive: [
        { binding: "HYPERDRIVE", id: LOCAL_HYPERDRIVE_ID, localConnectionString: attached.databaseUrl },
      ],
    }),
    durable_objects: base.durable_objects,
    migrations: base.migrations,
    ratelimits: base.ratelimits,
  };
}

/** A Hyperdrive id `wrangler dev --local` requires and never looks up. */
export const LOCAL_HYPERDRIVE_ID = "local-development";

/** One GET through the Worker, as a browser on the loopback origin sends it. */
function status(port, path) {
  return new Promise((resolveStatus) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `localhost:${port}` },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode);
      },
    );
    req.on("error", () => resolveStatus(0));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** Poll until `ready`, or until a child has stopped the loop. */
async function waitFor(what, ready, timeoutMs) {
  const start = Date.now();
  while (!stopping && !(await ready())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const port = devPort(process.env);
  const origin = devOrigin(port);
  const attached = hostedAttachment(process.env);
  const base = parseConfig(readFileSync(resolve(hosted, "wrangler.relay.jsonc"), "utf8"));
  const pageDir = resolve(devDir, "assets", PAGE_PATH.slice(1));
  // A page left by an earlier run would satisfy the first wait below.
  rmSync(devDir, { recursive: true, force: true });
  mkdirSync(pageDir, { recursive: true });
  const configPath = resolve(devDir, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(devConfig(base, port, attached), null, 2) + "\n");

  // Each package's own bin shim, which execs its tool, so a signal reaches it.
  const run = (name, args, cwd) => {
    const child = spawn(resolve(cwd, "node_modules/.bin", name), args, {
      cwd,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (!stopping) console.error(`${name} exited (${code ?? "signal"}); stopping.`);
      stop(code ?? 1);
    });
    children.push(child);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(0));

  // The page, rebuilt on every edit straight into the folder Wrangler serves.
  run(
    "vite",
    [
      "build", "--watch",
      "--config", "vite.one-time.config.ts",
      "--outDir", pageDir,
      "--emptyOutDir",
    ],
    lib,
  );
  await waitFor("the first page build", () => existsSync(resolve(pageDir, "index.html")), 180_000);
  if (stopping) return;

  run(
    "wrangler",
    [
      "dev",
      "--config", configPath,
      "--local",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--local-protocol", "http",
      "--show-interactive-dev-session=false",
    ],
    hosted,
  );
  await waitFor("the Worker", async () => (await status(port, PAGE_PATH)) === 200, 120_000);
  if (stopping) return;

  console.log(
    [
      "",
      `One-time rendezvous and phone page: ${origin}${PAGE_PATH}`,
      "Build a dev Burrow that opens its links here (e.g. `pnpm innerdogfood`) with:",
      `  DORMOUSE_RELAY_ORIGIN=${origin}`,
      // A local origin counts as Hosted only in a dev build
      // (docs/specs/relay.md -> "Relay origin").
      "  DORMOUSE_RELAY_IS_HOSTED=1",
      ...(attached ? [`Its device-code sign-in approves at ${attached.accountOrigin}.`] : []),
      "",
    ].join("\n"),
  );
  // Under `pnpm dev:hosted` the account origin is the page the loop serves.
  if (attached) return;
  // OSC 367 (docs/specs/dor-tool.md -> OSC 367): frame this port's page, not
  // Wrangler's inspector, which the same process tree also binds.
  process.stdout.write(
    `\u001b]367;serve;${JSON.stringify({ v: 1, port, path: PAGE_PATH })}\u001b\\`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    stop(1);
  });
}
