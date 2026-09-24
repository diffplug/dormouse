/**
 * The agent-browser provider beneath the shared browser host
 * (`browser-host.ts`; docs/specs/dor-browser.md → "Browser Host"):
 * imported by the VS Code extension host, bundled for the
 * standalone sidecar. What is genuinely agent-browser's lives here — its
 * per-session daemon and the state files it leaves beside its socket, the pid
 * kill a headed/headless relaunch needs, each operation's one fixed argv, and
 * the daemon's stream the host relays to its viewer socket. The host owns
 * everything the two providers share.
 *
 * Plain Node (child_process / fs / ws), so the same code runs on both hosts.
 */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
// All external spawns go through dor-lib-common's spawnAndCapture, which owns the
// Windows recipe (cross-spawn for PATHEXT/.cmd, windowsHide, exit-vs-close). The
// GUI host needs it even for the absolute `binaryPath` dor ab resolved.
// See docs/specs/dor-cli.md → "Spawning External Binaries".
import {
  BROWSER_PROVIDERS,
  isDirectory,
  parseStreamPort,
  spawnAndCapture,
  streamStatusArgs,
  AGENT_BROWSER_BIN_ENV,
  AGENT_BROWSER_SOCKET_DIR_ENV,
  DEFAULT_AGENT_BROWSER_BIN,
} from 'dor-lib-common';
import { WebSocket } from 'ws';
import { isAllowedAgentBrowserBinary } from '../lib/agent-browser-binary';
import { parseAgentBrowserTabs } from '../lib/agent-browser-tab';
import { CAPTURE_JPEG_QUALITY, type BrowserResult, type ViewerInput, type ViewerState } from '../lib/platform/browser-automation';
import type { BrowserAct, BrowserProvider, LiveBrowser, ProviderBinding } from './browser-host';
import { measuredViewport, type MeasuredViewport, type Upstream, type ViewerSink } from './browser-viewer';

const SESSION_ARGS = BROWSER_PROVIDERS['agent-browser'].sessionArgs;

// `tab`'s own verbs, which a tab id rendered after `tab` would run instead.
const TAB_VERBS = new Set(['new', 'close', 'list']);

/** The agent-browser argv for an operation — rebuilt from its validated
 *  fields, so no caller token reaches the CLI as it came; null for a tab id
 *  that would read as one of `tab`'s verbs. */
function actArgv(act: BrowserAct): string[] | null {
  switch (act.op) {
    case 'navigate': return ['open', act.url];
    case 'history': return [act.dir];
    case 'tab':
      if (TAB_VERBS.has(act.tabId)) return null;
      return act.action === 'select' ? ['tab', act.tabId] : ['tab', 'close', act.tabId];
    case 'viewport': return ['set', 'viewport', String(act.width), String(act.height), String(act.dpr)];
    case 'device': return ['set', 'device', act.name];
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
// A viewer's upstream dials — the daemon's stream, a headed window's CDP —
// and the `get cdp-url` before one, each end here at the latest.
const STREAM_CONNECT_TIMEOUT_MS = 5000;
const CDP_URL_TIMEOUT_MS = 10_000;
// A stream message above this size is a frame (a base64 JPEG); status, tabs
// and url are small — unless a long tab list or URL crosses it too.
const FRAME_THRESHOLD_BYTES = 16384;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AgentBrowserProviderDeps {
  /** Optional diagnostic logger. */
  log?: (message: string) => void;
}

/**
 * A paste for the daemon's stream, which takes only key and mouse events: a
 * key down and up per character, a newline as Enter.
 */
function keyPairTextInputs(text: string): Extract<ViewerInput, { type: 'input_keyboard' }>[] {
  const messages: Extract<ViewerInput, { type: 'input_keyboard' }>[] = [];
  for (const ch of text) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      messages.push({ type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, modifiers: 0 });
      messages.push({ type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', text: '', windowsVirtualKeyCode: 13, modifiers: 0 });
    } else {
      messages.push({ type: 'input_keyboard', eventType: 'keyDown', key: ch, code: '', text: ch, windowsVirtualKeyCode: 0, modifiers: 0 });
      messages.push({ type: 'input_keyboard', eventType: 'keyUp', key: ch, code: '', text: '', windowsVirtualKeyCode: 0, modifiers: 0 });
    }
  }
  return messages;
}

/** The viewport's CSS size a stream frame's metadata carries, when whole. */
function frameSize(metadata: { deviceWidth?: unknown; deviceHeight?: unknown } | undefined): { width: number; height: number } | undefined {
  const width = metadata?.deviceWidth;
  const height = metadata?.deviceHeight;
  return typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0 ? { width, height } : undefined;
}

// A frame's bulk is base64, whose alphabet has no `"` or `:`: these mark a
// control message large enough to pass for a frame.
const CONTROL_MARKERS = ['"type":"tabs"', '"type":"status"', '"type":"url"'];

/** A browser target that is one of its window's pages — never a DevTools
 *  window, a worker or a frame. */
function windowPage(info: unknown): { targetId: string; url: string; title?: unknown } | undefined {
  const t = info as { targetId?: unknown; type?: unknown; url?: unknown; title?: unknown } | null;
  if (!t || typeof t !== 'object' || typeof t.targetId !== 'string' || t.type !== 'page' || typeof t.url !== 'string') return undefined;
  return t.url.startsWith('devtools://') ? undefined : { targetId: t.targetId, url: t.url, title: t.title };
}

/** Calls over a CDP `socket`: each answers its result, or undefined for an
 *  error or a closed socket; every event goes to `event`. */
function cdpCalls(socket: WebSocket, event: (method: string, params: Record<string, unknown> | undefined) => void = () => {}) {
  let nextId = 1;
  const replies = new Map<number, (result: unknown) => void>();
  socket.on('message', (data: Buffer) => {
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      replies.get(message.id)?.(message.result);
      replies.delete(message.id);
    } else if (typeof message.method === 'string') {
      event(message.method, message.params);
    }
  });
  socket.on('close', () => {
    for (const reply of replies.values()) reply(undefined);
    replies.clear();
  });
  /** One call to the browser, or to the page `sessionId` is attached to. */
  return (method: string, params?: Record<string, unknown>, sessionId?: string) => new Promise<unknown>((resolve) => {
    if (socket.readyState !== WebSocket.OPEN) {
      resolve(undefined);
      return;
    }
    const id = nextId++;
    replies.set(id, resolve);
    socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
  });
}

// Run in each of a headed window's pages until one answers: the shown page's
// viewport (`measuredViewport`), measured this often.
const MEASURE_SCRIPT = "document.visibilityState === 'visible' ? { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } : null";
const MEASURE_INTERVAL_MS = 1000;

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
    return runWithBinaryFallback([...SESSION_ARGS(b.session), ...args], b.binaryPath, options);
  }

  // Read a session's stream WebSocket port via `stream status --json` — only
  // once `open` has returned, since any CLI verb starts a daemon to answer.
  // Right after it, the daemon may not have published the port yet; a single
  // read would then return undefined and leave the panel pinned to a stale
  // port. Retry briefly to close that window.
  async function readStreamPort(b: ProviderBinding, deadline: number): Promise<number | undefined> {
    for (let attempt = 0; attempt < STREAM_PORT_READ_ATTEMPTS; attempt++) {
      const result = await runWithBinaryFallback(streamStatusArgs(b.session), b.binaryPath, { timeoutMs: Math.max(0, deadline - Date.now()) });
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
    return process.env[AGENT_BROWSER_SOCKET_DIR_ENV] || path.join(os.homedir(), '.agent-browser');
  }

  // The daemon's state files beside its socket: `<session>.pid` and
  // `<session>.stream` (the stream server's port, written as the daemon comes
  // up — ~100ms into a launch, long before the page loads). Neither is cleaned
  // up when the daemon is killed, so a reader must know which daemon wrote it.
  // One written before this boot describes no process now running: its pid
  // is whatever process has that number since, so it reads as absent.
  async function readStateNumber(session: string, ext: 'pid' | 'stream'): Promise<number | undefined> {
    try {
      const file = path.join(agentBrowserStateDir(), `${session}.${ext}`);
      const [stat, text] = await Promise.all([fs.stat(file), fs.readFile(file, 'utf8')]);
      // `os.uptime` is whole seconds on some platforms: a second's slack.
      if (stat.mtimeMs < Date.now() - os.uptime() * 1000 - 1000) return undefined;
      const value = Number.parseInt(text.trim(), 10);
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

  /**
   * The session's daemon as its state files prove it: a pid file from this
   * boot naming a live process, beside a stream port that accepts. The one
   * proof the host acts on — to signal a pid, to run a verb, to capture — since
   * a pid file alone may name any process, and any verb run with no daemon up
   * starts one to answer.
   */
  async function liveDaemon(session: string): Promise<{ pid: number; stream: number } | undefined> {
    const pid = await readStateNumber(session, 'pid');
    if (pid === undefined || !processAlive(pid)) return undefined;
    const stream = await acceptingStreamPort(session);
    return stream === undefined ? undefined : { pid, stream };
  }

  /**
   * One CLI call on a live browser, refused unless `liveDaemon` proves the
   * session's daemon up: only a launch's own steps may start one
   * (docs/specs/dor-browser.md → "agent-browser"). A session in a socket
   * directory the host does not share has no state files here, so it is
   * refused too.
   */
  async function drive(b: ProviderBinding, args: string[], options?: { timeoutMs?: number }): Promise<CliResult> {
    if (!await liveDaemon(b.session)) throw new Error(`agent-browser session '${b.session}' is not running`);
    return run(b, args, options);
  }

  /** The browser's CDP endpoint, as `get cdp-url` run `via` names it — only
   *  ever on loopback. */
  async function askCdpEndpoint(b: ProviderBinding, via: typeof run): Promise<string | undefined> {
    const result = await via(b, ['get', 'cdp-url'], { timeoutMs: CDP_URL_TIMEOUT_MS });
    const url = result.exitCode === 0 ? parseCdpUrl(result.stdout) : null;
    if (!url) {
      log(`[agent-browser] no CDP endpoint for ${b.session}: ${cliError(result)}`);
      return undefined;
    }
    // The browser's own endpoint, and only ever on loopback.
    if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) {
      log(`[agent-browser] refused a CDP endpoint off loopback: ${url}`);
      return undefined;
    }
    return url;
  }

  // Each session's browser CDP endpoint, beside the stream port of the daemon
  // that named it: once a headed window has closed, any CLI verb run for its
  // browser opens a blank one (rationale), so a later observer of the same
  // daemon asks it nothing.
  const cdpEndpoints = new Map<string, { stream: number; url: string }>();

  /** The CDP endpoint of the browser the daemon streaming on `stream` runs,
   *  asked of that daemon once. */
  async function cdpEndpoint(b: ProviderBinding, stream: number): Promise<string | undefined> {
    const known = cdpEndpoints.get(b.session);
    if (known?.stream === stream) return known.url;
    const url = await askCdpEndpoint(b, drive);
    if (url) cdpEndpoints.set(b.session, { stream, url });
    return url;
  }

  /** One call to the session's browser over a connection of its own, for a
   *  launch's own steps once `open` has brought the daemon up. */
  async function browserCall(b: ProviderBinding, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const url = await askCdpEndpoint(b, run);
    if (!url) throw new Error(`agent-browser session '${b.session}' has no CDP endpoint`);
    const socket = new WebSocket(url, { handshakeTimeout: STREAM_CONNECT_TIMEOUT_MS, perMessageDeflate: false });
    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        // Kept for the socket's life: a later error must not go unhandled.
        socket.on('error', reject);
      });
      return await cdpCalls(socket)(method, params);
    } finally {
      socket.close();
    }
  }

  /** Terminate `session`'s daemon `pid`, proven live by the caller, and wait
   *  for it to exit. */
  async function killDaemon(session: string, pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // ESRCH: already dead
    }
    // Wait for the process to actually exit (signal 0 throws once it's gone), so
    // the relaunch doesn't race a daemon that's still shutting down.
    for (let i = 0; i < 40; i++) {
      if (!processAlive(pid)) {
        log(`[ab-relaunch] daemon ${pid} for ${session} exited after ${i * 50}ms`);
        return;
      }
      await delay(50);
    }
    log(`[ab-relaunch] daemon ${pid} for ${session} still alive after 2s; SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }


  return {
    pollMs: 100,

    bind: (binding) => binding,

    // One socket directory per host, so the session names the daemon.
    identity: (b) => b.session,

    describe: (b) => b,

    // The daemon as its state files describe it — a CLI verb would start one
    // to answer. One up but not streaming is left alone: relaunching would
    // compete with it.
    async find(b) {
      const live = await liveDaemon(b.session);
      if (live) return { stream: live.stream };
      const pid = await readStateNumber(b.session, 'pid');
      if (pid !== undefined && processAlive(pid)) throw new Error(`agent-browser session '${b.session}' is not streaming`);
      return { gone: `agent-browser session '${b.session}' is not running`, named: pid !== undefined };
    },

    // Close the browser, then fully stop the daemon so a relaunch isn't ignored
    // as "daemon already running" (a no-op without a daemon: `close` starts
    // none). Only a pid proven to be the daemon is signalled — named by a pid
    // file from this boot, alive, beside a stream port that accepts, checked
    // before `close` — since a pid file alone may name any process. Answers
    // that pid, live or not, so `probe` tells the replacement from the state
    // files the old daemon left.
    async stop(b, timeoutMs) {
      const pid = await readStateNumber(b.session, 'pid');
      const proven = await liveDaemon(b.session);
      await run(b, ['close'], { timeoutMs });
      if (proven) await killDaemon(b.session, proven.pid);
      return pid;
    },

    // `open` returns when the page's `load` event fires — up to the CLI's
    // action timeout (25s in 0.31.1), after which it exits non-zero with the
    // browser live on the page — and every other daemon command queues behind
    // it. Run in the project directory, for the config a `dor ab` there read.
    async open(b, url, headed) {
      // The project's directory, so agent-browser reads its
      // `./agent-browser.json`, while that directory still exists.
      const cwd = b.cwd !== undefined && isDirectory(b.cwd) ? b.cwd : undefined;
      const result = await run(b, [...(headed ? ['--headed'] : []), 'open', url ?? 'about:blank'], { cwd });
      log(`[ab-relaunch] open session=${b.session} exit=${result.exitCode}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ''}`);
      return { exitCode: result.exitCode, stderr: result.stderr };
    },

    // Up once the *daemon* is: its pid file names a pid other than the one a
    // relaunch just killed, and its stream file a port that accepts. The stream
    // serves status/tabs/frames while `open` still waits on the page. Once
    // `open` has returned, a non-zero exit with the daemon up is a page still
    // loading, not a failed launch — without a pid file (an older CLI) the exit
    // code is all there is.
    async probe(b, { replaced, opened, deadline }): Promise<LiveBrowser | { failed: string } | undefined> {
      const pid = await readStateNumber(b.session, 'pid');
      const daemonUp = pid !== undefined && pid !== replaced;
      if (opened) {
        if (opened.exitCode !== 0 && !daemonUp) return { failed: opened.stderr.trim() || `agent-browser open exited ${opened.exitCode}` };
        const port = await readStreamPort(b, deadline);
        return port !== undefined ? { stream: port } : { failed: 'agent-browser published no stream port' };
      }
      if (!daemonUp) return undefined;
      const port = await acceptingStreamPort(b.session);
      return port !== undefined ? { stream: port } : undefined;
    },

    async close(b, timeoutMs) {
      const result = await run(b, ['close'], { timeoutMs });
      if (result.exitCode !== 0) throw new Error(cliError(result));
    },

    // The browser's own pages, over its CDP: `tab list` leaves out the
    // `chrome://newtab/` page every launch opens beside its own (rationale).
    // A page closed this way leaves `tab list` too.
    async listTabs(b) {
      const listed = await browserCall(b, 'Target.getTargets') as { targetInfos?: unknown } | undefined;
      const infos: unknown[] = Array.isArray(listed?.targetInfos) ? listed.targetInfos : [];
      return infos.map(windowPage).filter((page) => page !== undefined).map(({ targetId, url }) => ({ tabId: targetId, url }));
    },

    async closeTab(b, tabId) {
      await browserCall(b, 'Target.closeTarget', { targetId: tabId });
    },

    async act(b, act): Promise<BrowserResult> {
      const argv = actArgv(act);
      if (!argv) return { ok: false, error: 'invalid tab operation' };
      const result = await drive(b, argv);
      return result.exitCode === 0 ? { ok: true } : { ok: false, error: cliError(result) };
    },

    // eval --json envelope: { success, data: { result }, error }.
    async evaluate(b, script) {
      const result = await drive(b, ['eval', script, '--json']);
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
    async screenshot(b, file) {
      const out = await file();
      const args = ['screenshot', out, '--screenshot-format', 'jpeg', '--screenshot-quality', String(CAPTURE_JPEG_QUALITY)];
      const result = await drive(b, args, { timeoutMs: CAPTURE_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        log(`[agent-browser] screenshot failed (exit ${result.exitCode}): ${cliError(result)}`);
        throw new Error(result.stderr.trim() || `screenshot exited ${result.exitCode}`);
      }
      return { path: out };
    },

    view: (b, port, { headed }, sink) => viewStream(b, port, headed, sink),
  };

  /**
   * The daemon's stream at `port`, relayed to one viewer socket. The daemon
   * re-sends its current frame and tab list ~20 times a second whether or not
   * they changed, so each is compared raw against the last and dropped when
   * equal: only a changed frame is parsed, decoded once and passed on. A
   * headed viewer gets no frames: its window is followed over the browser's
   * CDP (`observeWindow`) — navigations made in the window itself, which the
   * stream does not report, its pages, and its viewport.
   *
   * `port` is the one `dor ab` read after its command, or a launch or attach
   * answered: it is only ever dialed on loopback, only the stream's own
   * messages come back from it, and only validated input goes to it. The
   * host captures the browser only when its own state files prove that port
   * the session's live daemon (`liveDaemon`); a daemon in a socket directory
   * it does not share is watched, never captured, and that directory never
   * read.
   */
  async function viewStream(b: ProviderBinding, port: number, headed: boolean, sink: ViewerSink): Promise<Upstream> {
    const capturable = (await liveDaemon(b.session))?.stream === port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: STREAM_CONNECT_TIMEOUT_MS, perMessageDeflate: false });
    let opened = false;
    let closing = false;
    let observer: { close(): void } | null = null;
    let lastFrame: Buffer | undefined;
    const lastState = new Map<string, string>();
    // The stream's status names the daemon's configured viewport, which a
    // headed window does not follow: the window's own, as its page reports
    // it, replaces it.
    let status: Extract<ViewerState, { type: 'status' }> | undefined;
    let windowViewport: MeasuredViewport | undefined;
    let sentStatus: string | undefined;
    const sendStatus = () => {
      if (!status) return;
      const message = { ...status, ...windowViewport };
      const json = JSON.stringify(message);
      if (json === sentStatus) return;
      sentStatus = json;
      sink.state(message);
    };
    socket.on('error', (error) => log(`[agent-browser] stream error: ${error.message}`));
    const open = new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        opened = true;
        resolve();
      });
      socket.on('close', () => {
        observer?.close();
        if (!opened) reject(new Error(`no agent-browser stream answers on port ${port}`));
        else if (!closing) sink.gone();
      });
    });
    socket.on('message', (data: Buffer, isBinary) => {
      if (isBinary) return;
      // A re-broadcast frame is dropped before it is parsed.
      const large = data.length > FRAME_THRESHOLD_BYTES && !CONTROL_MARKERS.some((marker) => data.includes(marker));
      if (large && (headed || lastFrame?.equals(data))) return;
      const text = data.toString();
      let message: { type?: unknown; data?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown }; connected?: unknown; screencasting?: unknown; viewportWidth?: unknown; viewportHeight?: unknown; tabs?: unknown; url?: unknown };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === 'frame' && typeof message.data === 'string') {
        if (headed || lastFrame?.equals(data)) return;
        lastFrame = data;
        sink.frame(Buffer.from(message.data, 'base64'), frameSize(message.metadata));
        return;
      }
      if (message.type === 'url') {
        // A commit edge, never deduplicated: a reload commits the same URL.
        if (typeof message.url === 'string') sink.state({ type: 'url', url: message.url });
        return;
      }
      if (message.type !== 'status' && message.type !== 'tabs') return;
      if (lastState.get(message.type) === text) return;
      lastState.set(message.type, text);
      if (message.type === 'tabs') {
        if (Array.isArray(message.tabs)) sink.state({ type: 'tabs', tabs: parseAgentBrowserTabs(message.tabs) });
        return;
      }
      status = {
        type: 'status',
        connected: message.connected === true,
        screencasting: message.screencasting === true,
        ...(typeof message.viewportWidth === 'number' ? { viewportWidth: message.viewportWidth } : {}),
        ...(typeof message.viewportHeight === 'number' ? { viewportHeight: message.viewportHeight } : {}),
      };
      sendStatus();
    });
    await open;
    if (headed) {
      observer = observeWindow(b, port, sink, (measured) => {
        windowViewport = measured;
        sendStatus();
      });
    }
    const forward = (message: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    return {
      capturable,
      input(message) {
        if (message.type === 'input_text') for (const key of keyPairTextInputs(message.text)) forward(key);
        else forward(message);
        return true;
      },
      close() {
        closing = true;
        observer?.close();
        socket.close();
      },
    };
  }

  /**
   * Follow a headed window over its browser's CDP: the URL and title of each
   * page target as it is created or changes, and each main-frame navigation;
   * how many pages it has, DevTools' aside, which the host reads as the
   * window closing once none is left (`ViewerSink.pages`); and each second,
   * the shown page's viewport and device pixel ratio (`measured`). The CDP
   * socket stays in the host.
   */
  function observeWindow(b: ProviderBinding, stream: number, sink: ViewerSink, measured: (viewport: MeasuredViewport) => void): { close(): void } {
    let closed = false;
    let cdp: WebSocket | null = null;
    let measuring: ReturnType<typeof setTimeout> | undefined;
    const page = (url: unknown, title: unknown) => {
      if (typeof url === 'string') sink.state({ type: 'page', url, title: typeof title === 'string' ? title : null });
    };
    void cdpEndpoint(b, stream).then((url) => {
      if (closed || !url) return;
      const socket = cdp = new WebSocket(url, { handshakeTimeout: STREAM_CONNECT_TIMEOUT_MS, perMessageDeflate: false });

      // The window's pages by target id, each with the session it is
      // measured on once attached. Counted only once listed whole.
      const pages = new Map<string, string | undefined>();
      let listed = false;
      const count = () => { if (listed) sink.pages(pages.size); };
      const track = (info: unknown) => {
        const target = windowPage(info);
        if (!target) return;
        if (!pages.has(target.targetId)) pages.set(target.targetId, undefined);
        page(target.url, target.title);
      };
      const call = cdpCalls(socket, (method, params) => {
        switch (method) {
          case 'Target.targetCreated':
          case 'Target.targetInfoChanged':
            track(params?.targetInfo);
            count();
            break;
          case 'Target.targetDestroyed':
            if (typeof params?.targetId === 'string') pages.delete(params.targetId);
            count();
            break;
          case 'Page.frameNavigated': {
            const frame = params?.frame as { parentId?: unknown; url?: unknown; name?: unknown } | undefined;
            if (!frame?.parentId) page(frame?.url, frame?.name);
            break;
          }
        }
      });

      // The first page shown — a background tab may keep its old size.
      const measure = async () => {
        for (const targetId of [...pages.keys()]) {
          const attached = pages.get(targetId) ?? (await call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof attached !== 'string' || !pages.has(targetId)) continue;
          pages.set(targetId, attached);
          const answer = await call('Runtime.evaluate', { expression: MEASURE_SCRIPT, returnByValue: true }, attached) as { result?: { value?: unknown } } | undefined;
          const viewport = measuredViewport(answer?.result?.value);
          if (viewport) {
            measured(viewport);
            return;
          }
        }
      };
      const measureAgain = () => {
        measuring = setTimeout(() => void measure().finally(() => { if (!closed) measureAgain(); }), MEASURE_INTERVAL_MS);
      };

      socket.on('open', () => {
        void call('Target.setDiscoverTargets', { discover: true });
        void call('Target.getTargets').then((result) => {
          const infos = (result as { targetInfos?: unknown } | undefined)?.targetInfos;
          if (!Array.isArray(infos)) return;
          for (const info of infos) track(info);
          // A window that closed before this observer came has none.
          listed = true;
          count();
          void measure().finally(() => { if (!closed) measureAgain(); });
        });
        // Were the endpoint a page's rather than the browser's, its own events
        // would be the navigation source.
        void call('Page.enable');
      });
      socket.on('error', (error) => {
        log(`[agent-browser] CDP observer error: ${error.message}`);
        // The next observer asks the daemon again.
        if (cdpEndpoints.get(b.session)?.url === url) cdpEndpoints.delete(b.session);
      });
    }).catch((error: unknown) => log(`[agent-browser] CDP observer: ${error instanceof Error ? error.message : String(error)}`));
    return {
      close() {
        closed = true;
        clearTimeout(measuring);
        cdp?.close();
      },
    };
  }
}
