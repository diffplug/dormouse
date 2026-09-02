#!/usr/bin/env node
/**
 * Drive the self-host setup → pairing story against the real Server and the
 * real Host, with real browsers, and leave every artifact behind.
 * `scripts/pairing-walkthrough/README.md` is the operator's guide — what it
 * needs, what it leaves behind, and what it does not cover; this file is the
 * entry point. **Never wire it into `pnpm test` or a CI workflow.**
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEPS } from './steps.mjs';
import { delay, exec, findFreePort, isPortFree, killTree, spawnedHandles } from './proc.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Not an option, and `--server-port` is deliberately not one: the Host's allowed
 * relay origins are baked into its sidecar bundle from
 * `DORMOUSE_REMOTE_CONNECT_SRC` at stage time, and Pocket must be same-origin
 * with its own API, so both sides of a run are pinned to one origin.
 */
const SERVER_PORT = 3000;

/** The defaults `parseArgs` starts from, and the ones `usage` prints. */
function defaults() {
  return {
    until: STEPS.at(-1).name,
    out: '$TMPDIR/pairing-walkthrough/<timestamp>',
    skipBuild: false,
    password: 'walkthrough-hunter2',
    machineName: 'Walkthrough Mac',
    keep: false,
  };
}

function parseArgs(argv) {
  const opts = { ...defaults(), out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--until': opts.until = value(); break;
      case '--out': opts.out = value(); break;
      case '--skip-build': opts.skipBuild = true; break;
      case '--password': opts.password = value(); break;
      case '--machine-name': opts.machineName = value(); break;
      case '--keep': opts.keep = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  if (!STEPS.some((step) => step.name === opts.until)) {
    throw new Error(`--until must be one of: ${STEPS.map((s) => s.name).join(', ')}`);
  }
  return opts;
}

function usage() {
  const d = defaults();
  return [
    'Usage: node scripts/pairing-walkthrough/run.mjs [options]',
    '',
    `  --until <step>     stop after this step (default: ${d.until})`,
    `                     steps: ${STEPS.map((s) => s.name).join(', ')}`,
    `  --out <dir>        run directory (default: ${d.out})`,
    '  --skip-build       reuse lib/dist-pocket and server/dist instead of rebuilding',
    `  --password <pw>    DORMOUSE_SETUP_PASSWORD for the run (default: ${d.password})`,
    `  --machine-name <n> the name the Host enrolls under (default: ${d.machineName})`,
    '  --keep             leave everything running when the run ends, pass or fail',
    '',
  ].join('\n');
}

/**
 * `live` is the handle the signal handlers hold: everything they need to tear
 * down is written into it as soon as it exists, so a Ctrl-C mid-step still
 * stops what has already started.
 */
async function main(live) {
  const opts = parseArgs(process.argv.slice(2));
  live.opts = opts;
  if (opts.help) {
    process.stdout.write(usage());
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = opts.out
    ? (isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out))
    : join(tmpdir(), 'pairing-walkthrough', stamp);
  mkdirSync(runDir, { recursive: true });

  if (!(await isPortFree(SERVER_PORT))) {
    throw new Error(
      `something is already listening on :${SERVER_PORT}; stop it first ` +
        '(the Server origin is baked into the Host bundle, so this port is not negotiable)',
    );
  }
  opts.vitePort = await findFreePort(15540);
  opts.hostPort = await findFreePort(opts.vitePort + 1);
  opts.session = `pairing-walkthrough-${stamp}`;

  /** Every file the run left behind, by name. A re-captured QR rewrites its own. */
  const artifacts = new Set();
  const summary = {
    startedAt: new Date().toISOString(),
    runDir,
    options: { ...opts },
    steps: [],
    artifacts: [],
    facts: {},
  };
  const state = live.state;
  // Cleanup identifies the Pocket Chrome by its profile path; see `cleanup`.
  state.runDir = runDir;

  const ctx = {
    repoRoot,
    runDir,
    opts,
    state,
    serverPort: SERVER_PORT,
    serverOrigin: `http://localhost:${SERVER_PORT}`,
    viteOrigin: `http://localhost:${opts.vitePort}`,
    artifacts,
    log: (message) => console.log(`[walkthrough] ${message}`),
    record: (facts) => Object.assign(summary.facts, facts),
    /** Write `text` into the run directory and register it as an artifact. */
    write: (name, text) => {
      writeFileSync(join(runDir, name), `${text}\n`);
      artifacts.add(name);
    },
    /**
     * Screenshot a browser into the run directory — the Host's by default, the
     * Pocket one when it is passed.
     *
     * **Every screenshot also writes `<name>.txt`.** A later pass critiques
     * every string a user meets along this path, and a PNG is not something it
     * can read; the text dump is its raw material, so it is taken here rather
     * than left to each step to remember.
     */
    shot: async (name, browser = state.hostBrowser) => {
      if (!browser) throw new Error('no browser to screenshot yet');
      await browser.screenshot(join(runDir, name));
      artifacts.add(name);
      const text = await browser
        .visibleText()
        .catch((err) => `(text capture failed: ${err.message})`);
      ctx.write(`${name.replace(/\.png$/, '')}.txt`, text ?? '');
    },
  };
  // Written by the children rather than by a step, so registered here.
  for (const log of ['server.log', 'host.log', 'pocket-chrome.log', 'pocket-console.log']) {
    artifacts.add(log);
  }

  ctx.record({ serverOrigin: ctx.serverOrigin });
  console.log(`[walkthrough] run directory: ${runDir}`);
  console.log(`[walkthrough] server ${ctx.serverOrigin} · vite ${ctx.viteOrigin} · bridge :${opts.hostPort}`);
  console.log(`[walkthrough] agent-browser session: ${opts.session}`);

  const lastIndex = STEPS.findIndex((step) => step.name === opts.until);
  let reached = null;
  let failure = null;

  for (const step of STEPS.slice(0, lastIndex + 1)) {
    const startedAt = Date.now();
    console.log(`[walkthrough] → ${step.name}: ${step.title}`);
    try {
      await step.run(ctx);
      summary.steps.push({ name: step.name, status: 'ok', ms: Date.now() - startedAt });
      reached = step.name;
    } catch (err) {
      summary.steps.push({
        name: step.name,
        status: 'failed',
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      failure = err;
      break;
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.artifacts = [...artifacts];
  summary.reached = reached;
  summary.ok = failure === null;
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (failure) console.error(`[walkthrough] FAILED at ${summary.steps.at(-1)?.name}: ${failure.message}`);
  console.log(`[walkthrough] reached: ${reached ?? '(nothing)'}`);
  console.log(`[walkthrough] run directory: ${runDir}`);
  return failure ? 1 : 0;
}

/**
 * Stop everything this run started, in reverse order, and say what survived.
 *
 * The browser is two things, not one — Chrome and the per-session daemon behind
 * it, which `close` leaves running (`ab.mjs` → `killDaemon`).
 */
async function cleanup(state, opts) {
  // Written before anything is closed, and on the failure path too: the Host
  // mirrors its webview's console into `host.log`, and this is the Pocket
  // side's only equivalent — the one place a client-side throw shows up at all.
  if (state.pocketAuth && state.runDir) {
    const { messages } = state.pocketAuth.session;
    writeFileSync(join(state.runDir, 'pocket-console.log'), `${messages.join('\n')}\n`);
  }
  // The CDP socket next: it is the only thing holding the Pocket page's virtual
  // authenticator, and closing it after Chrome is gone throws.
  state.pocketAuth?.session.close();
  for (const browser of [state.pocketBrowser, state.hostBrowser]) {
    if (!browser) continue;
    await browser.close();
    await browser.killDaemon().catch(() => {});
  }
  for (const handle of spawnedHandles()) await killTree(handle);
  // The harness's own children can outlive a SIGTERM that arrived while pnpm
  // was still wiring up its tree.
  await delay(500);
  // The Pocket Chrome answers to neither name — it is not an agent-browser
  // session and not a harness child by the time it matters — so its profile
  // path, which is inside the run directory, is what identifies it.
  //
  // No shell, and the run directory escaped: `--out` takes any path, `pgrep -f`
  // reads its pattern as an ERE, and a directory holding a quote or a paren
  // would otherwise turn this check into a syntax error that `catch` swallows —
  // leaving the run silent about processes it failed to stop.
  const marks = ['dev-agent-browser.mjs', opts?.session ?? 'pairing-walkthrough', state.runDir]
    .filter(Boolean)
    .map((mark) => mark.replaceAll(/[.[\]{}()*+?^$|\\]/g, String.raw`\$&`))
    .join('|');
  // pgrep exits 1 when nothing matches, which `exec` reports as a failure.
  const survivors = await exec('pgrep', ['-fl', marks]).catch(() => ({ stdout: '' }));
  // **This process and the shell that started it match the marks themselves.**
  // `pairing-walkthrough` is a substring of this script's own path, and `--out`
  // puts the run directory in its own argv — so a diagnostic whose whole job is
  // to say "something leaked" would cry wolf on every path that ends before
  // `opts.session` exists: `--help`, a bad flag, and the `:3000` refusal a
  // first-time run is most likely to hit. (Whether the parent is listed at all
  // is a `pgrep` difference — GNU lists it, BSD does not — which is not
  // something to leave the answer resting on.)
  const mine = new Set([process.pid, process.ppid]);
  const left = survivors.stdout
    .split('\n')
    .filter((line) => line.trim() && !mine.has(Number(line.trim().split(/\s+/)[0])));
  if (left.length > 0) {
    console.error(`[walkthrough] processes survived cleanup:\n${left.join('\n')}`);
  }
}

/**
 * The one way out. `exit: true` is the signal path, which has no stack to
 * return to; the normal path sets `process.exitCode` and lets the loop drain.
 */
let cleaning = false;
async function shutdown(code, live, { exit = false } = {}) {
  if (cleaning) return;
  cleaning = true;
  await cleanup(live.state, live.opts).catch((err) =>
    console.error(`[walkthrough] cleanup: ${err.message}`),
  );
  if (exit) process.exit(code);
  process.exitCode = code;
}

const live = { state: {}, opts: null };
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(130, live, { exit: true }); });
}
// The two ways out that skip `main`'s own `catch`, and the two that would
// otherwise leave a Server, a Host and two Chromes running with nobody left to
// stop them: a stream that errors (`spawnLogged`'s log file) and a promise
// nothing awaited (a CDP `send` outstanding when its socket closes).
for (const fault of ['uncaughtException', 'unhandledRejection']) {
  process.on(fault, (err) => {
    console.error(`[walkthrough] ${fault}: ${err instanceof Error ? err.stack : String(err)}`);
    void shutdown(1, live, { exit: true });
  });
}

let exitCode = 1;
try {
  exitCode = await main(live);
} catch (err) {
  console.error(`[walkthrough] ${err instanceof Error ? err.stack : String(err)}`);
}
if (live.opts?.keep) {
  // **A failed run is kept too.** Standing in the wreckage is what `--keep` is
  // for, and tearing down on the way out would remove the only thing left to
  // look at.
  //
  // Stay alive rather than detaching: these children write into pipes this
  // process owns, so exiting would close their stdout mid-sentence. Ctrl-C
  // lands on the SIGINT handler above and tears everything down.
  console.log(
    `[walkthrough] --keep (exit ${exitCode}): what is up is still up. Ctrl-C to stop it.`,
  );
  await new Promise(() => {});
} else {
  await shutdown(exitCode, live);
}
