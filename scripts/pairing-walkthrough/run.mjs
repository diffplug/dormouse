#!/usr/bin/env node
/**
 * Drive the self-host setup → pairing story against the real Server and the
 * real Host, with real browsers, and leave every artifact behind.
 * `scripts/pairing-walkthrough/README.md` is the operator's guide; this file is
 * the entry point.
 *
 * Not in CI and not wired into any `pnpm test`: it wants Chrome, `ffmpeg`, a
 * free `:3000`, and several minutes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEPS } from './steps.mjs';
import { delay, exec, findFreePort, isPortFree, killTree, spawnedHandles } from './proc.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const opts = {
    until: 'qr',
    out: null,
    skipBuild: false,
    password: 'walkthrough-hunter2',
    machineName: 'Walkthrough Mac',
    serverPort: 3000,
    keep: false,
  };
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
  return [
    'Usage: node scripts/pairing-walkthrough/run.mjs [options]',
    '',
    '  --until <step>     stop after this step (default: qr)',
    `                     steps: ${STEPS.map((s) => s.name).join(', ')}`,
    '  --out <dir>        run directory (default: $TMPDIR/pairing-walkthrough/<timestamp>)',
    '  --skip-build       reuse lib/dist-pocket and server/dist instead of rebuilding',
    '  --password <pw>    DORMOUSE_SETUP_PASSWORD for the run',
    '  --machine-name <n> the name the Host enrolls under',
    '  --keep             leave the Server and Host running after the last step',
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

  if (!(await isPortFree(opts.serverPort))) {
    // Not a port this run can move: the Host's allowed relay origins are baked
    // at build time from `DORMOUSE_REMOTE_CONNECT_SRC`, and the Pocket app must
    // be same-origin with its own API, so both sides are pinned to one origin.
    throw new Error(
      `something is already listening on :${opts.serverPort}; stop it first ` +
        '(the Server origin is baked into the Host bundle, so this port is not negotiable)',
    );
  }
  opts.vitePort = await findFreePort(15540);
  opts.hostPort = await findFreePort(opts.vitePort + 1);
  opts.session = `pairing-walkthrough-${stamp}`;

  const summary = {
    startedAt: new Date().toISOString(),
    runDir,
    options: { ...opts },
    steps: [],
    artifacts: [],
    facts: {},
  };
  const state = live.state;
  let shotSeq = 0;

  const ctx = {
    repoRoot,
    runDir,
    opts,
    state,
    serverOrigin: `http://localhost:${opts.serverPort}`,
    viteOrigin: `http://localhost:${opts.vitePort}`,
    artifacts: summary.artifacts,
    log: (message) => console.log(`[walkthrough] ${message}`),
    record: (facts) => Object.assign(summary.facts, facts),
    /** Screenshot the Host webview into the run directory. */
    shot: async (name) => {
      shotSeq++;
      if (!state.hostBrowser) throw new Error('no browser to screenshot yet');
      await state.hostBrowser.screenshot(join(runDir, name));
      summary.artifacts.push(name);
      return name;
    },
  };

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
 * The browser is two things, not one: `close` stops Chrome but leaves the
 * per-session daemon alive holding its profile and its headed/headless mode, so
 * the daemon has to be signalled by pid. `close --all` is deliberately not used
 * — it would take down every other agent-browser session on the machine.
 */
async function cleanup(state, opts) {
  if (state.hostBrowser) {
    await state.hostBrowser.close();
    await state.hostBrowser.killDaemon().catch(() => {});
  }
  for (const handle of spawnedHandles()) await killTree(handle);
  // The harness's own children can outlive a SIGTERM that arrived while pnpm
  // was still wiring up its tree.
  await delay(500);
  const survivors = await exec('/bin/sh', ['-c',
    `pgrep -fl 'dev-agent-browser.mjs|${opts?.session ?? 'pairing-walkthrough'}' || true`]).catch(() => ({ stdout: '' }));
  if (survivors.stdout.trim()) {
    console.error(`[walkthrough] processes survived cleanup:\n${survivors.stdout.trim()}`);
  }
}

let cleaning = false;
async function shutdown(code, live) {
  if (cleaning) return;
  cleaning = true;
  await cleanup(live.state, live.opts).catch((err) =>
    console.error(`[walkthrough] cleanup: ${err.message}`),
  );
  process.exit(code);
}

const live = { state: {}, opts: null };
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(130, live); });
}

let exitCode = 1;
try {
  exitCode = await main(live);
} catch (err) {
  console.error(`[walkthrough] ${err instanceof Error ? err.stack : String(err)}`);
}
if (live.opts?.keep && exitCode === 0) {
  // Stay alive rather than detaching: these children write into pipes this
  // process owns, so exiting would close their stdout mid-sentence. Ctrl-C
  // lands on the SIGINT handler above and tears everything down.
  console.log('[walkthrough] --keep: the Server and Host are still running. Ctrl-C to stop them.');
  await new Promise(() => {});
} else {
  cleaning = true;
  await cleanup(live.state, live.opts).catch((err) =>
    console.error(`[walkthrough] cleanup: ${err.message}`),
  );
  process.exitCode = exitCode;
}
