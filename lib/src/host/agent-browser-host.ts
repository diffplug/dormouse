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
import { CAPTURE_JPEG_QUALITY, type BrowserResult, type ViewerInput } from '../lib/platform/browser-automation';
import type { BrowserAct, BrowserProvider, LiveBrowser, ProviderBinding } from './browser-host';
import type { Upstream, ViewerSink } from './browser-viewer';

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
const STREAM_CONNECT_TIMEOUT_MS = 5000;
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
export function keyPairTextInputs(text: string): Extract<ViewerInput, { type: 'input_keyboard' }>[] {
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

  /**
   * One CLI call on a live browser. Any verb starts a daemon to answer when
   * none runs, so it is refused unless the session's daemon runs as its pid
   * file says: only a launch's own steps may start one (docs/specs/dor-browser.md
   * → "Browser Host"). A session in a socket directory the host does not
   * share has no pid file here, so it is refused too.
   */
  async function drive(b: ProviderBinding, args: string[], options?: { timeoutMs?: number }): Promise<CliResult> {
    const pid = await readStateNumber(b.session, 'pid');
    if (pid === undefined || !processAlive(pid)) throw new Error(`agent-browser session '${b.session}' is not running`);
    return run(b, args, options);
  }

  /** The port `<session>.stream` names, when something accepts on it. */
  async function acceptingStreamPort(session: string): Promise<number | undefined> {
    const port = await readStateNumber(session, 'stream');
    return port !== undefined && await portAccepts(port) ? port : undefined;
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
      const pid = await readStateNumber(b.session, 'pid');
      if (pid !== undefined && processAlive(pid)) {
        const port = await acceptingStreamPort(b.session);
        if (port !== undefined) return { stream: port };
        throw new Error(`agent-browser session '${b.session}' is not streaming`);
      }
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
      const proven = pid !== undefined && processAlive(pid) && await acceptingStreamPort(b.session) !== undefined;
      await run(b, ['close'], { timeoutMs });
      if (proven) await killDaemon(b.session, pid);
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

    async closeTab(b, tabId) {
      await run(b, ['tab', 'close', tabId]);
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
   * headed viewer gets no frames, and its page is followed over the browser's
   * CDP (`observePage`), which the stream does not report for navigations
   * made in the window itself.
   *
   * `port` may be one `dor ab` read under a socket directory the host does
   * not share: it is only ever dialed on loopback, only the stream's own
   * messages come back from it, and only validated input goes to it.
   */
  async function viewStream(b: ProviderBinding, port: number, headed: boolean, sink: ViewerSink): Promise<Upstream> {
    // Only a daemon in the host's own socket directory is one it can capture.
    const capturable = (await readStateNumber(b.session, 'stream')) === port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: STREAM_CONNECT_TIMEOUT_MS, perMessageDeflate: false });
    let opened = false;
    let closing = false;
    let observer: { close(): void } | null = null;
    let lastFrame: Buffer | undefined;
    const lastState = new Map<string, string>();
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
      const large = data.length > FRAME_THRESHOLD_BYTES && !CONTROL_MARKERS.some((marker) => data.includes(marker));
      if (large) {
        if (headed || lastFrame?.equals(data)) return;
        lastFrame = data;
      }
      const text = data.toString();
      let message: { type?: unknown; data?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown }; connected?: unknown; screencasting?: unknown; viewportWidth?: unknown; viewportHeight?: unknown; tabs?: unknown; url?: unknown };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === 'frame' && typeof message.data === 'string') {
        if (headed) return;
        if (!large) {
          if (lastFrame?.equals(data)) return;
          lastFrame = data;
        }
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
      sink.state({
        type: 'status',
        connected: message.connected === true,
        screencasting: message.screencasting === true,
        ...(typeof message.viewportWidth === 'number' ? { viewportWidth: message.viewportWidth } : {}),
        ...(typeof message.viewportHeight === 'number' ? { viewportHeight: message.viewportHeight } : {}),
      });
    });
    await open;
    if (headed) observer = observePage(b, sink);
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
   * Follow a headed window's page over its browser's CDP: the URL and title
   * of each page target as it is created or changes, and each main-frame
   * navigation. The endpoint is asked of the daemon, which is up while its
   * stream is; the CDP socket stays in the host.
   */
  function observePage(b: ProviderBinding, sink: ViewerSink): { close(): void } {
    let closed = false;
    let cdp: WebSocket | null = null;
    const page = (url: unknown, title: unknown) => {
      if (typeof url === 'string') sink.state({ type: 'page', url, title: typeof title === 'string' ? title : null });
    };
    void drive(b, ['get', 'cdp-url']).then((result) => {
      const url = result.exitCode === 0 ? parseCdpUrl(result.stdout) : null;
      if (closed || !url) {
        if (!url) log(`[agent-browser] no CDP endpoint for ${b.session}: ${cliError(result)}`);
        return;
      }
      // The browser's own endpoint, and only ever on loopback.
      if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) {
        log(`[agent-browser] refused a CDP endpoint off loopback: ${url}`);
        return;
      }
      const socket = cdp = new WebSocket(url, { perMessageDeflate: false });
      let nextId = 1;
      const send = (method: string, params?: Record<string, unknown>) => socket.send(JSON.stringify({ id: nextId++, method, ...(params ? { params } : {}) }));
      socket.on('open', () => {
        send('Target.setDiscoverTargets', { discover: true });
        send('Target.getTargets');
        // Were the endpoint a page's rather than the browser's, its own events
        // would be the navigation source.
        send('Page.enable');
      });
      socket.on('error', (error) => log(`[agent-browser] CDP observer error: ${error.message}`));
      socket.on('message', (data: Buffer) => {
        let message: { method?: string; params?: { targetInfo?: unknown; frame?: { parentId?: unknown; url?: unknown; name?: unknown } }; result?: { targetInfos?: unknown } };
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        const target = (info: unknown) => {
          const t = info as { type?: unknown; url?: unknown; title?: unknown } | null;
          if (t && typeof t === 'object' && t.type === 'page') page(t.url, t.title);
        };
        if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') target(message.params?.targetInfo);
        else if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) page(message.params?.frame?.url, message.params?.frame?.name);
        else if (Array.isArray(message.result?.targetInfos)) for (const info of message.result.targetInfos) target(info);
      });
    }).catch((error: unknown) => log(`[agent-browser] CDP observer: ${error instanceof Error ? error.message : String(error)}`));
    return {
      close() {
        closed = true;
        cdp?.close();
      },
    };
  }
}
