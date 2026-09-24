/**
 * The agent-browser provider beneath the shared browser host
 * (`browser-host.ts`; docs/specs/dor-browser.md → "Agent-Browser Host
 * Capabilities"): imported by the VS Code extension host, bundled for the
 * standalone sidecar. What is genuinely agent-browser's lives here — its
 * per-session daemon and the state files it leaves beside its socket, the pid
 * kill a headed/headless relaunch needs, and each operation's one fixed argv.
 * The host owns everything the two providers share.
 *
 * Plain Node (child_process / fs), so the same code runs on both hosts. The
 * VS Code stream relay is NOT here: it works around the `vscode-webview://`
 * origin the agent-browser stream server rejects, which is a VS-Code-only
 * concern (the standalone webview's `tauri://localhost` origin is accepted, so
 * it connects directly). It stays in the VS Code host, injected as `streamUrl`.
 */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promises as fs, statSync } from 'fs';
// All external spawns go through dor-lib-common's spawnAndCapture, which owns the
// Windows recipe (cross-spawn for PATHEXT/.cmd, windowsHide, exit-vs-close). The
// GUI host needs it even for the absolute `binaryPath` dor ab resolved.
// See docs/specs/dor-cli.md → "Spawning External Binaries".
import {
  spawnAndCapture,
  parseStreamPort,
  streamStatusArgs,
  AGENT_BROWSER_BIN_ENV,
  DEFAULT_AGENT_BROWSER_BIN,
} from 'dor-lib-common';
import { isAllowedAgentBrowserBinary } from '../lib/agent-browser-binary';
import { parseAgentBrowserTabs } from '../lib/agent-browser-tab';
import type { BrowserResult } from '../lib/platform/browser-automation';
import type { BrowserAct, BrowserProvider, LiveBrowser, ProviderBinding } from './browser-host';

/** The agent-browser argv for an operation — rebuilt from its validated
 *  fields, so no caller token reaches the CLI as it came. */
function actArgv(act: BrowserAct): string[] {
  switch (act.op) {
    case 'navigate': return ['open', act.url];
    case 'history': return [act.dir];
    case 'tab': return act.action === 'select' ? ['tab', act.tabId] : ['tab', 'close', act.tabId];
    case 'viewport': return ['set', 'viewport', String(act.width), String(act.height), String(act.dpr)];
    case 'device': return ['set', 'device', act.name];
    case 'cdpUrl': return ['get', 'cdp-url'];
  }
}

/** The browser-level CDP WebSocket `get cdp-url` printed, plain or JSON. */
function parseCdpUrl(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { data?: { result?: unknown }; result?: unknown; url?: unknown };
    const value = parsed.data?.result ?? parsed.result ?? parsed.url;
    if (typeof value === 'string' && value.startsWith('ws://')) return value;
  } catch {
    // Plain text is the common CLI output.
  }
  return trimmed.match(/ws:\/\/\S+/)?.[0] ?? null;
}

/** One CLI run's outcome. */
type CliResult = { exitCode: number; stdout: string; stderr: string };

function cliError(result: CliResult): string {
  return result.stderr.trim() || result.stdout.trim() || `agent-browser exited ${result.exitCode}`;
}

// A capture can queue behind a page-loading `open` for the CLI's whole 25s
// action timeout; past this it is wedged, and killed so it cannot pin the
// host's capture join. Every adapter has stopped waiting by then anyway.
const CAPTURE_TIMEOUT_MS = 30_000;
const STREAM_PORT_READ_ATTEMPTS = 4;
const STREAM_PORT_READ_DELAY_MS = 150;
const PORT_PROBE_TIMEOUT_MS = 500;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AgentBrowserProviderDeps {
  /** Optional diagnostic logger. */
  log?: (message: string) => void;
  /** The stream URL for a port; absent, the webview dials it directly. */
  streamUrl?: (port: number) => Promise<string>;
}

export function createAgentBrowserProvider(deps: AgentBrowserProviderDeps = {}): BrowserProvider<ProviderBinding> {
  const log = deps.log ?? (() => {});

  // The host's PATH is often the GUI login PATH (no nvm/volta shims), so prefer
  // the absolute path `dor ab` resolved in the user's terminal; fall through on
  // ENOENT (binary missing) to the next candidate in case it has gone stale.
  //
  // The one gate every spawn shares. `binaryPath` arrives from the webview
  // realm and from a pane's persisted Lath params, so an unchecked one is
  // arbitrary local execution in the extension host or the Tauri sidecar — the
  // exact escape the nonce CSP exists to prevent, and reachable without any user
  // interaction on the next launch. The request validation does not cover it:
  // every operation takes a `binaryPath` of its own. A refused path is dropped,
  // not fatal: the host's own candidates still run, so a stale or hostile value
  // degrades to "resolve it yourself" rather than to a broken surface.
  async function runWithBinaryFallback(
    args: string[],
    binaryPath?: string,
    options: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<CliResult> {
    const configured = process.env[AGENT_BROWSER_BIN_ENV];
    if (binaryPath !== undefined && !isAllowedAgentBrowserBinary(binaryPath, configured)) {
      log(`[agent-browser] refused a caller-supplied binary path that is not an agent-browser: ${JSON.stringify(binaryPath)}`);
      binaryPath = undefined;
    }
    const candidates = [...new Set([
      binaryPath,
      configured,
      DEFAULT_AGENT_BROWSER_BIN,
    ].filter((c): c is string => !!c))];

    // Only what is set, so an unbounded run in the host's cwd spawns as a bare one.
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    let lastError = '';
    for (const binary of candidates) {
      const result = await (Object.keys(given).length ? spawnAndCapture(binary, args, given) : spawnAndCapture(binary, args));
      if (result.ok) {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      // Missing binary: record it and try the next candidate. Any other spawn
      // failure is real — surface it rather than masking it behind a fallback.
      if (result.error.code !== 'ENOENT') {
        log(`[agent-browser] spawn failed: ${result.error.message}`);
        return { exitCode: 1, stdout: '', stderr: result.error.message };
      }
      lastError = `'${binary}' was not found`;
      log(`[agent-browser] ${lastError}; trying next candidate`);
    }
    return { exitCode: 1, stdout: '', stderr: `agent-browser binary not found (${lastError})` };
  }

  function run(b: ProviderBinding, args: string[], options?: { timeoutMs?: number; cwd?: string }): Promise<CliResult> {
    return runWithBinaryFallback(['--session', b.session, ...args], b.binaryPath, options);
  }

  // Read a session's stream WebSocket port via `stream status --json` — only
  // once `open` has returned, since any CLI verb starts a daemon to answer.
  // Right after it, the daemon may not have published the port yet; a single
  // read would then return undefined and leave the panel pinned to a stale
  // port. Retry briefly to close that window.
  async function readStreamPort(b: ProviderBinding): Promise<number | undefined> {
    for (let attempt = 0; attempt < STREAM_PORT_READ_ATTEMPTS; attempt++) {
      const result = await runWithBinaryFallback(streamStatusArgs(b.session), b.binaryPath);
      if (result.exitCode === 0) {
        const port = parseStreamPort(result.stdout);
        if (port !== undefined) return port;
      }
      if (attempt < STREAM_PORT_READ_ATTEMPTS - 1) await delay(STREAM_PORT_READ_DELAY_MS);
    }
    return undefined;
  }

  // agent-browser keeps a long-lived per-session daemon whose headed/headless
  // mode is fixed at *its* launch. `close` only closes the browser, not the
  // daemon, and there is no CLI verb to stop it — so a `--headed`/headless
  // relaunch against a live daemon is silently ignored ("daemon already
  // running"), and pop-out/pop-in never actually switches mode. The daemon's pid
  // lives in `$AGENT_BROWSER_SOCKET_DIR/<session>.pid` (default ~/.agent-browser);
  // terminate it and wait for the process to exit so the next `open` spawns a
  // fresh daemon in the mode we ask for. Best-effort and cross-platform
  // (process.kill works on win/mac/linux).
  function agentBrowserStateDir(): string {
    return process.env.AGENT_BROWSER_SOCKET_DIR || path.join(os.homedir(), '.agent-browser');
  }

  // The daemon's state files beside its socket: `<session>.pid` and
  // `<session>.stream` (the stream server's port, written as the daemon comes
  // up — ~100ms into a launch, long before the page loads). Neither is cleaned
  // up when the daemon is killed, so a reader must know which daemon wrote it.
  async function readStateNumber(session: string, ext: 'pid' | 'stream'): Promise<number | undefined> {
    try {
      const value = Number.parseInt((await fs.readFile(path.join(agentBrowserStateDir(), `${session}.${ext}`), 'utf8')).trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined; // absent (no daemon yet, custom dir, or an older CLI)
    }
  }

  function portAccepts(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const settle = (accepted: boolean) => { socket.destroy(); resolve(accepted); };
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
    });
  }

  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // ESRCH (gone), or EPERM: not a daemon this user started
    }
  }

  /** The port `<session>.stream` names, when something accepts on it. */
  async function acceptingStreamPort(session: string): Promise<number | undefined> {
    const port = await readStateNumber(session, 'stream');
    return port !== undefined && await portAccepts(port) ? port : undefined;
  }

  /** Terminate the session's daemon and wait for it to exit. Returns the pid
   *  the pid file named (dead or not), so a relaunch can tell the daemon that
   *  replaces it from the stale state files it leaves behind. */
  async function killDaemon(session: string): Promise<number | undefined> {
    const pid = await readStateNumber(session, 'pid');
    if (pid === undefined) return undefined; // no pid file — nothing to kill (already gone, or custom dir)
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return pid; // ESRCH: already dead
    }
    // Wait for the process to actually exit (signal 0 throws once it's gone), so
    // the relaunch doesn't race a daemon that's still shutting down.
    for (let i = 0; i < 40; i++) {
      if (!processAlive(pid)) {
        log(`[ab-relaunch] daemon ${pid} for ${session} exited after ${i * 50}ms`);
        return pid;
      }
      await delay(50);
    }
    log(`[ab-relaunch] daemon ${pid} for ${session} still alive after 2s; SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    return pid;
  }

  /** The launch's working directory: the project's, so agent-browser reads its
   *  `./agent-browser.json`, while that directory still exists. */
  function projectDir(cwd: string | undefined): string | undefined {
    try {
      return cwd !== undefined && statSync(cwd).isDirectory() ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    pollMs: 100,

    bind: (binding) => binding,

    // One socket directory per host, so the session names the daemon.
    identity: (b) => b.session,

    describe: (b) => ({
      session: b.session,
      ...(b.cwd !== undefined ? { cwd: b.cwd } : {}),
      ...(b.binaryPath !== undefined ? { binaryPath: b.binaryPath } : {}),
    }),

    // The daemon as its state files describe it — a CLI verb would start one
    // to answer. One up but not streaming is left alone: relaunching would
    // compete with it.
    async find(b) {
      const pid = await readStateNumber(b.session, 'pid');
      if (pid !== undefined && processAlive(pid)) {
        const port = await acceptingStreamPort(b.session);
        if (port !== undefined) return { wsPort: port };
        throw new Error(`agent-browser session '${b.session}' is not streaming`);
      }
      return { gone: `agent-browser session '${b.session}' is not running`, named: pid !== undefined };
    },

    // Close the browser, then fully stop the daemon so a relaunch isn't ignored
    // as "daemon already running" (a no-op without a daemon: `close` starts
    // none).
    async stop(b, timeoutMs) {
      await run(b, ['close'], { timeoutMs: Math.max(0, timeoutMs) });
      return killDaemon(b.session);
    },

    // `open` returns when the page's `load` event fires — up to the CLI's
    // action timeout (25s in 0.31.1), after which it exits non-zero with the
    // browser live on the page — and every other daemon command queues behind
    // it. Run in the project directory, for the config a `dor ab` there read.
    async open(b, url, headed) {
      const result = await run(b, [...(headed ? ['--headed'] : []), 'open', url ?? 'about:blank'], { cwd: projectDir(b.cwd) });
      log(`[ab-relaunch] open session=${b.session} exit=${result.exitCode}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ''}`);
      return { exitCode: result.exitCode, stderr: result.stderr };
    },

    // Up once the *daemon* is: its pid file names a pid other than the one a
    // relaunch just killed, and its stream file a port that accepts. The stream
    // serves status/tabs/frames while `open` still waits on the page. Once
    // `open` has returned, a non-zero exit with the daemon up is a page still
    // loading, not a failed launch — without a pid file (an older CLI) the exit
    // code is all there is.
    async probe(b, { replaced, opened }): Promise<LiveBrowser | { failed: string } | undefined> {
      const pid = await readStateNumber(b.session, 'pid');
      const daemonUp = pid !== undefined && pid !== replaced;
      if (opened) {
        if (opened.exitCode !== 0 && !daemonUp) return { failed: opened.stderr.trim() || `agent-browser open exited ${opened.exitCode}` };
        const port = await readStreamPort(b);
        return port !== undefined ? { wsPort: port } : { failed: 'agent-browser published no stream port' };
      }
      if (!daemonUp) return undefined;
      const port = await acceptingStreamPort(b.session);
      return port !== undefined ? { wsPort: port } : undefined;
    },

    async close(b, timeoutMs) {
      const result = await run(b, ['close'], timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, timeoutMs) });
      if (result.exitCode !== 0) throw new Error(cliError(result));
    },

    // Envelope: { tabs } or { data: { tabs } }; the record parse is shared with
    // the live stream (parseAgentBrowserTabs). Empty on any failure.
    async listTabs(b) {
      const result = await run(b, ['tab', 'list', '--json']);
      if (result.exitCode !== 0) return [];
      try {
        const parsed = JSON.parse(result.stdout) as { tabs?: unknown; data?: { tabs?: unknown } };
        return parseAgentBrowserTabs(parsed.data?.tabs ?? parsed.tabs);
      } catch {
        return [];
      }
    },

    async act(b, act): Promise<BrowserResult> {
      const result = await run(b, actArgv(act));
      if (result.exitCode !== 0) return { ok: false, error: cliError(result) };
      if (act.op !== 'cdpUrl') return { ok: true };
      const url = parseCdpUrl(result.stdout);
      return url ? { ok: true, url } : { ok: false, error: 'agent-browser printed no CDP endpoint' };
    },

    // eval --json envelope: { success, data: { result }, error }.
    async evaluate(b, script) {
      const result = await run(b, ['eval', script, '--json']);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `eval exited ${result.exitCode}`);
      let envelope: { success?: boolean; data?: { result?: unknown }; error?: unknown };
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw new Error('could not parse eval output');
      }
      if (envelope.success === false) throw new Error(typeof envelope.error === 'string' ? envelope.error : 'eval failed');
      return envelope.data?.result;
    },

    // agent-browser's `screenshot` honors the session's viewport/DPR, unlike
    // the CSS-resolution screencast, and writes the frame where it is told.
    async screenshot(b, { format, quality }, file) {
      const out = await file();
      const args = ['screenshot', out, '--screenshot-format', format];
      if (format === 'jpeg') args.push('--screenshot-quality', String(quality));
      const result = await run(b, args, { timeoutMs: CAPTURE_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        log(`[agent-browser] screenshot failed (exit ${result.exitCode}): ${cliError(result)}`);
        throw new Error(result.stderr.trim() || `screenshot exited ${result.exitCode}`);
      }
      return { path: out };
    },

    streamUrl: async (port) => (deps.streamUrl ? deps.streamUrl(port) : `ws://127.0.0.1:${port}`),
  };
}
