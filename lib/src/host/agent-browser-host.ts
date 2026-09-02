/**
 * Host-agnostic agent-browser support (docs/specs/dor-browser.md →
 * "Agent-Browser Host Capabilities"). The single source of truth for both hosts:
 *
 *   - VS Code: the extension host imports this directly
 *     (`vscode-ext/src/agent-browser-host.ts`).
 *   - Standalone: bundled to `standalone/sidecar/agent-browser-host.cjs` and run
 *     by the Node sidecar, fronted by thin Rust forwarders — exactly how the
 *     iframe proxy (`iframe-proxy.ts`) is shared.
 *
 * Everything here is plain Node (child_process / fs / crypto), so the *same*
 * code runs on both hosts. Only two genuinely host-specific bits are injected:
 * writing the OS clipboard (for the macOS editing chords) and logging.
 *
 * Narrow capabilities, all on behalf of the webview:
 *
 * 1. `command` — runs the user's agent-browser binary against a session for tab
 *    actions, navigation, and teardown. Subcommands are allowlisted; not a
 *    general exec channel.
 * 2. `edit` — host-owned `eval` for the macOS editing chords
 *    (select-all/copy/cut) the stream input path can't dispatch; copy/cut land
 *    on the OS clipboard.
 * 3. `screenshot` — captures one device-resolution frame and returns the bytes.
 * 4. `streamStatus` — reads the current stream port so restored panels recover
 *    from a stale persisted `wsPort`.
 * 5. `open` — spawns a managed namespaced session and opens a url, backing a
 *    render swap (docs/specs/dor-browser.md → "Display Modal And Render Swaps").
 * 6. `popOut` / `popIn` — relaunch a session headed/headless at its live active
 *    url (Chrome's mode is fixed at launch, so this is a close + relaunch).
 * 7. `closePoppedOut` — close every still-headed window **and drop the capture
 *    directory**, called from each host's shutdown so quitting never orphans a
 *    real Chrome window or leaves a frame of the user's browser in tmp.
 *
 * The VS Code stream relay is NOT here: it works around the `vscode-webview://`
 * origin the agent-browser stream server rejects, which is a VS-Code-only
 * concern (the standalone webview's `tauri://localhost` origin is accepted, so
 * it connects directly). It stays in the VS Code host.
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs, rmSync } from 'fs';
// All external spawns go through dor-lib-common's spawnAndCapture, which owns the
// Windows recipe (cross-spawn for PATHEXT/.cmd, windowsHide, exit-vs-close). The
// GUI host needs it even for the absolute `binaryPath` dor ab resolved.
// See docs/specs/dor-cli.md → "Spawning External Binaries".
import {
  spawnAndCapture,
  parseStreamPort,
  sessionForKey,
  streamStatusArgs,
  AGENT_BROWSER_BIN_ENV,
  DEFAULT_AGENT_BROWSER_BIN,
} from 'dor-lib-common';
import { randomBytes } from 'crypto';
import { isAllowedAgentBrowserBinary } from '../lib/agent-browser-binary';
import { type AgentBrowserTab, parseAgentBrowserTabs } from '../lib/agent-browser-tab';
import {
  AGENT_BROWSER_ALLOWED_SUBCOMMANDS,
  type AgentBrowserCommandResult,
  type AgentBrowserEditOp,
  type AgentBrowserEditResult,
  type AgentBrowserOpenResult,
  type AgentBrowserPopResult,
  type AgentBrowserScreenshotResult,
  type AgentBrowserStreamStatusResult,
} from '../lib/platform/types';

const ALLOWED_SUBCOMMANDS = new Set<string>(AGENT_BROWSER_ALLOWED_SUBCOMMANDS);

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. copy/cut return the
// selected text; selectAll returns ''. Inputs/textareas use selection ranges;
// everything else falls back to the Selection API + execCommand.
const EDIT_SCRIPTS: Record<AgentBrowserEditOp, string> = {
  selectAll: `(()=>{const el=document.activeElement;if(el&&'select'in el&&'value'in el){el.select();}else{document.execCommand('selectAll');}return'';})()`,
  copy: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){return el.value.slice(el.selectionStart,el.selectionEnd);}return String(window.getSelection()||'');})()`,
  cut: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){const s=el.selectionStart,e=el.selectionEnd,t=el.value.slice(s,e);el.setRangeText('',s,e,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return t;}const sel=String(window.getSelection()||'');if(sel)document.execCommand('delete');return sel;})()`,
};

const STREAM_PORT_READ_ATTEMPTS = 4;
const STREAM_PORT_READ_DELAY_MS = 150;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AgentBrowserHostDeps {
  /** Write text to the OS clipboard (copy/cut land here). VS Code passes
   *  `vscode.env.clipboard.writeText`; the sidecar shells out (pbcopy/clip/…). */
  writeClipboardText: (text: string) => Promise<void> | void;
  /** Optional diagnostic logger. */
  log?: (message: string) => void;
}

/** Path-only capture result — the bytes stay on disk for the caller to read
 *  (the standalone Rust forwarder reads the file itself; see `screenshotToFile`). */
export type AgentBrowserScreenshotFileResult =
  | { ok: true; path: string; mime: string }
  | { ok: false; error: string };

export interface AgentBrowserHost {
  command(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult>;
  edit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult>;
  screenshot(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult>;
  screenshotToFile(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotFileResult>;
  streamStatus(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult>;
  open(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult>;
  popOut(session: string, opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult>;
  popIn(session: string, opts: { url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult>;
  closePoppedOut(): Promise<void>;
}

export function createAgentBrowserHost(deps: AgentBrowserHostDeps): AgentBrowserHost {
  const log = deps.log ?? (() => {});

  // Sessions currently relaunched headed via pop-out, mapped to the binary path
  // that spawned them. A headed session is a real OS window, so the host must
  // close it on shutdown or it orphans (spec → "Pop-Out" lifecycle:
  // "Dormouse/editor quits → headed windows are cleaned up; no orphans").
  // Headless sessions are deliberately NOT tracked — they're left alive to
  // reattach across webview reloads (the wsPort/stream-recovery design).
  const poppedOutSessions = new Map<string, string | undefined>();

  // The host's PATH is often the GUI login PATH (no nvm/volta shims), so prefer
  // the absolute path `dor ab` resolved in the user's terminal; fall through on
  // ENOENT (binary missing) to the next candidate in case it has gone stale.
  //
  // The one gate every entry point shares. `binaryPath` arrives from the webview
  // realm and from a pane's persisted Lath params, so an unchecked one is
  // arbitrary local execution in the extension host or the Tauri sidecar — the
  // exact escape the nonce CSP exists to prevent, and reachable without any user
  // interaction on the next launch. The subcommand allowlist in `command()` does
  // not cover it: `streamStatus`, `open` and `popOut` supply their own args and
  // take a `binaryPath` of their own. A refused path is dropped, not fatal: the
  // host's own candidates still run, so a stale or hostile value degrades to
  // "resolve it yourself" rather than to a broken surface.
  async function runWithBinaryFallback(args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
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

    let lastError = '';
    for (const binary of candidates) {
      const result = await spawnAndCapture(binary, args);
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

  // Read a session's stream WebSocket port via `stream status --json` (parsed by
  // dor-lib-common's parseStreamPort). Right after `open` / `--headed open` (a
  // fresh spawn, a pop-out, or a pop-in relaunch) the daemon may not have
  // published the port yet; a single read would then return undefined and leave
  // the panel pinned to a stale port — it reads "ended" though the session is
  // live. Retry briefly to close that window.
  async function readStreamPort(session: string, binaryPath?: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < STREAM_PORT_READ_ATTEMPTS; attempt++) {
      const result = await runWithBinaryFallback(streamStatusArgs(session), binaryPath);
      if (result.exitCode === 0) {
        const port = parseStreamPort(result.stdout);
        if (port !== undefined) return port;
      }
      if (attempt < STREAM_PORT_READ_ATTEMPTS - 1) await delay(STREAM_PORT_READ_DELAY_MS);
    }
    return undefined;
  }

  function usableRelaunchUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'about:blank') return undefined;
    return trimmed;
  }

  // Enumerate a session's tabs via `tab list --json`. Envelope mirrors the rest
  // of the CLI parsing here: { tabs } or { data: { tabs } }; the record parse is
  // shared with the live stream (parseAgentBrowserTabs). Returns [] on any
  // failure so callers degrade gracefully.
  async function listTabs(session: string, binaryPath?: string): Promise<AgentBrowserTab[]> {
    const result = await runWithBinaryFallback(['--session', session, 'tab', 'list', '--json'], binaryPath);
    if (result.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(result.stdout) as { tabs?: unknown; data?: { tabs?: unknown } };
      return parseAgentBrowserTabs(parsed.data?.tabs ?? parsed.tabs);
    } catch {
      return [];
    }
  }

  // Dormouse is the source of truth for the relaunch target: the panel observes
  // the live `tabs` stream and tracks the active tab's URL in its params, then
  // passes it here. We deliberately do NOT re-query the daemon — right after
  // `close` the daemon relaunches at about:blank, so a `get url` / `tab list`
  // would race the very transition it's meant to preserve and hand back blank.
  function relaunchUrl(requestedUrl: unknown): string {
    return usableRelaunchUrl(requestedUrl) ?? 'about:blank';
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

  async function killDaemon(session: string): Promise<void> {
    const pidFile = path.join(agentBrowserStateDir(), `${session}.pid`);
    let pid: number;
    try {
      pid = Number.parseInt((await fs.readFile(pidFile, 'utf8')).trim(), 10);
    } catch {
      return; // no pid file — nothing to kill (already gone, or custom dir)
    }
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // ESRCH: already dead
    }
    // Wait for the process to actually exit (signal 0 throws once it's gone), so
    // the relaunch doesn't race a daemon that's still shutting down.
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        log(`[ab-relaunch] daemon ${pid} for ${session} exited after ${i * 50}ms`);
        return;
      }
      await delay(50);
    }
    log(`[ab-relaunch] daemon ${pid} for ${session} still alive after 2s; SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }

  // After a relaunch, close any stray about:blank tab the close+reopen race can
  // leave behind — but only when a real page is open, so we never close the sole
  // tab. Best-effort: a failure here must not fail the pop-out/pop-in.
  async function closeStrayBlankTabs(session: string, binaryPath?: string): Promise<void> {
    const tabs = await listTabs(session, binaryPath);
    log(`[ab-relaunch] tabs after open: ${JSON.stringify(tabs)}`);
    if (tabs.length < 2 || !tabs.some((t) => usableRelaunchUrl(t.url))) return;
    for (const tab of tabs) {
      if (!usableRelaunchUrl(tab.url)) {
        log(`[ab-relaunch] closing stray blank tab ${tab.tabId}`);
        await runWithBinaryFallback(['--session', session, 'tab', 'close', tab.tabId], binaryPath);
      }
    }
  }

  // A fresh managed session for a surface spawned from the GUI (no `--key`),
  // using dor ab's workspace-scoped sessionForKey namespacing so it can't collide
  // with a user's own agent-browser sessions.
  function generateGuiSession(): string {
    return sessionForKey(`gui-${randomBytes(6).toString('hex')}`);
  }

  // Screenshots of the user's authenticated browser land here, written by an
  // external process under the ambient umask, so the *directory* is the control:
  // one `mkdtemp` per host process, which is `0700` and unguessable. A derivable
  // path directly in `os.tmpdir()` let any other local account read every frame,
  // or pre-create the name as a symlink and have agent-browser clobber whatever
  // it pointed at. `standalone/sidecar/clipboard-ops.js` does the same for
  // clipboard images; the two paths are meant to match, cleanup included — a
  // frame of someone's authenticated browser is not something to leave in tmp
  // for the OS to reap whenever it gets round to it.
  let screenshotDirOnce: Promise<string> | null = null;
  let screenshotDirPath: string | null = null;
  function screenshotDir(): Promise<string> {
    // mkdtemp creates at 0700 already; the chmod covers an inherited-mode
    // filesystem and is a no-op on Windows, where %TEMP% is per-user.
    screenshotDirOnce ??= fs.mkdtemp(path.join(os.tmpdir(), 'dormouse-ab-')).then(async (dir) => {
      if (process.platform !== 'win32') await fs.chmod(dir, 0o700).catch(() => {});
      screenshotDirPath = dir;
      // Backstop for an exit that never reaches `closePoppedOut` — a crash, or
      // a host that skips its shutdown hook. An `exit` handler cannot await,
      // hence the sync removal.
      process.once('exit', () => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      });
      return dir;
    }).catch((err: unknown) => {
      // Never memoize the failure. `??=` would otherwise cache the rejected
      // promise, so one transient EACCES/ENOSPC on tmpdir would disable
      // screenshots for the rest of this process's life with no retry.
      screenshotDirOnce = null;
      throw err;
    });
    return screenshotDirOnce;
  }

  /** Drop the whole capture directory. Called on shutdown; safe to repeat. */
  async function removeScreenshotDir(): Promise<void> {
    const dir = screenshotDirPath;
    screenshotDirOnce = null;
    screenshotDirPath = null;
    screenshotNames.clear();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // Reused per session so we don't litter with one file per frame; the panel
  // guarantees one screenshot in flight per surface, so overwriting is safe. The
  // random component is per session, so the name stays stable for reuse while
  // being unguessable from the session key alone.
  const screenshotNames = new Map<string, string>();
  async function screenshotPath(session: string, ext: string): Promise<string> {
    let name = screenshotNames.get(session);
    if (name === undefined) {
      name = randomBytes(12).toString('hex');
      screenshotNames.set(session, name);
    }
    return path.join(await screenshotDir(), `shot-${name}.${ext}`);
  }

  async function command(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
    if (typeof session !== 'string' || !session) {
      return { exitCode: 1, stdout: '', stderr: 'session is required' };
    }
    const subcommand = args[0];
    if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { exitCode: 1, stdout: '', stderr: `agent-browser subcommand '${subcommand ?? ''}' is not allowed from the webview` };
    }
    if (subcommand === 'get' && args[1] !== 'cdp-url') {
      return { exitCode: 1, stdout: '', stderr: `agent-browser get '${args[1] ?? ''}' is not allowed from the webview` };
    }
    // An explicit close (kill / render-swap) tears the session down itself, so
    // it's no longer ours to clean up on shutdown.
    if (subcommand === 'close') poppedOutSessions.delete(session);
    return runWithBinaryFallback(['--session', session, ...args], binaryPath);
  }

  async function edit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult> {
    if (typeof session !== 'string' || !session) {
      return { ok: false, error: 'session is required' };
    }
    const script = EDIT_SCRIPTS[op];
    if (!script) {
      return { ok: false, error: `unknown edit op '${op}'` };
    }

    const result = await runWithBinaryFallback(['--session', session, 'eval', script, '--json'], binaryPath);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr.trim() || `eval exited ${result.exitCode}` };
    }

    // eval --json envelope: { success, data: { result }, error }.
    let text = '';
    try {
      const envelope = JSON.parse(result.stdout) as { success?: boolean; data?: { result?: unknown }; error?: unknown };
      if (envelope.success === false) {
        return { ok: false, error: typeof envelope.error === 'string' ? envelope.error : `${op} failed` };
      }
      if (typeof envelope.data?.result === 'string') text = envelope.data.result;
    } catch {
      return { ok: false, error: `could not parse eval output for ${op}` };
    }

    if (op === 'selectAll') return { ok: true };
    // Land the grabbed text on the user's real OS clipboard. Skip empty so an
    // empty selection doesn't clobber what's already there.
    if (text) {
      try {
        await deps.writeClipboardText(text);
      } catch (err) {
        return { ok: false, error: `clipboard write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { ok: true, text };
  }

  // Capture one device-resolution frame via the user's agent-browser
  // `screenshot` command (which honors the session's viewport/DPR, unlike the
  // CSS-resolution screencast). agent-browser writes the frame to a temp file and
  // reports its path; this returns that PATH without reading the bytes.
  //
  // The two hosts read the file differently, and that split is the whole point of
  // keeping this path-only:
  //   - VS Code: `screenshot()` (below) reads the bytes here and structured-clones
  //     them to the webview.
  //   - Standalone: the sidecar hands this path to Rust, which reads the file
  //     itself and returns a raw Response — so the ~100-700KB of image bytes never
  //     ride the JSON-lines stdio pipe shared with all PTY terminal traffic.
  async function screenshotToFile(
    session: string,
    opts: { format?: 'jpeg' | 'png'; quality?: number },
    binaryPath?: string,
  ): Promise<AgentBrowserScreenshotFileResult> {
    if (typeof session !== 'string' || !session) {
      return { ok: false, error: 'session is required' };
    }
    const format = opts.format === 'png' ? 'png' : 'jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';
    let out: string;
    try {
      // Every other failure in here answers `{ ok: false, error }`; a tmpdir
      // that cannot be created must not escape as a rejection instead.
      out = await screenshotPath(session, ext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[agent-browser] could not create the capture directory: ${message}`);
      return { ok: false, error: `could not create a private screenshot directory: ${message}` };
    }
    const args = ['--session', session, 'screenshot', out, '--screenshot-format', format];
    if (format === 'jpeg') {
      const q = Number.isFinite(opts.quality) ? Math.min(100, Math.max(1, Math.round(opts.quality as number))) : 85;
      args.push('--screenshot-quality', String(q));
    }
    const result = await runWithBinaryFallback(args, binaryPath);
    if (result.exitCode !== 0) {
      log(`[agent-browser] screenshot failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
      return { ok: false, error: result.stderr.trim() || `screenshot exited ${result.exitCode}` };
    }
    return { ok: true, path: out, mime: format === 'png' ? 'image/png' : 'image/jpeg' };
  }

  // Byte-returning wrapper over screenshotToFile for the VS Code host (structured
  // clone to the webview). The standalone sidecar deliberately does NOT use this;
  // it forwards the path so Rust reads the file off the stdio hot path.
  async function screenshot(
    session: string,
    opts: { format?: 'jpeg' | 'png'; quality?: number },
    binaryPath?: string,
  ): Promise<AgentBrowserScreenshotResult> {
    const shot = await screenshotToFile(session, opts, binaryPath);
    if (!shot.ok) return { ok: false, error: shot.error };
    try {
      const buffer = await fs.readFile(shot.path);
      // A Uint8Array view over exactly this file's bytes.
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      // The bytes are in memory now and this path owns the file's whole life,
      // so the frame does not sit on disk until shutdown. The path-returning
      // sibling cannot do this — its caller (Rust) reads the file afterwards —
      // so there the next capture overwrites it and shutdown removes the dir.
      await fs.unlink(shot.path).catch(() => {});
      return { ok: true, bytes, mime: shot.mime };
    } catch (err) {
      log(`[agent-browser] screenshot read failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: `could not read screenshot file: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function streamStatus(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult> {
    if (typeof session !== 'string' || !session) return { ok: false, error: 'session is required' };
    const wsPort = await readStreamPort(session, binaryPath);
    if (!wsPort) return { ok: false, error: 'stream port unavailable' };
    return { ok: true, wsPort };
  }

  // Spawn a managed session and open <url> — backs swapping an iframe embed up
  // to a live screencast (docs/specs/dor-browser.md → "Display Modal And Render Swaps"). With `headed`,
  // the process launches headed in one shot so embed→popout doesn't open a
  // headless browser only to tear it down.
  async function open(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult> {
    if (typeof url !== 'string' || !url) return { ok: false, error: 'url is required' };
    const session = generateGuiSession();
    const args = ['--session', session, ...(opts?.headed ? ['--headed'] : []), 'open', url];
    const opened = await runWithBinaryFallback(args, binaryPath);
    if (opened.exitCode !== 0) {
      return { ok: false, error: opened.stderr.trim() || `open exited ${opened.exitCode}` };
    }
    // A headed spawn is a real OS window — track it so shutdown can close it.
    if (opts?.headed) poppedOutSessions.set(session, binaryPath);
    const wsPort = await readStreamPort(session, binaryPath);
    return { ok: true, session, ...(wsPort ? { wsPort } : {}), ...(binaryPath ? { binaryPath } : {}) };
  }

  // Pop-out is a relaunch, not a live toggle: Chrome's headed/headless choice is
  // fixed at launch (spec → "Pop-Out"). Close the headless session, then
  // reopen it headed at the active URL. (v1 preserves the active tab URL only;
  // multi-tab + profile/cookie restore are tracked follow-ups. Window
  // positioning over opts.rect is deferred — neither host acts on it yet, so the
  // window opens where Chrome places it.)
  async function popOut(
    session: string,
    opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string },
    binaryPath?: string,
  ): Promise<AgentBrowserPopResult> {
    if (typeof session !== 'string' || !session) return { ok: false, error: 'session is required' };
    const url = relaunchUrl(opts?.url);
    log(`[ab-relaunch] popOut session=${session} requestedUrl=${JSON.stringify(opts?.url)} -> open ${url}`);
    // Close the browser, then fully stop the daemon so the headed relaunch isn't
    // ignored as "daemon already running" (which would leave it headless).
    await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
    await killDaemon(session);
    const opened = await runWithBinaryFallback(['--session', session, '--headed', 'open', url], binaryPath);
    log(`[ab-relaunch] popOut headed-open exit=${opened.exitCode}${opened.stderr.trim() ? ` stderr=${opened.stderr.trim()}` : ''}`);
    if (opened.exitCode !== 0) {
      return { ok: false, error: opened.stderr.trim() || `headed open exited ${opened.exitCode}` };
    }
    // Now a real headed OS window — track it so shutdown can close it.
    poppedOutSessions.set(session, binaryPath);
    await closeStrayBlankTabs(session, binaryPath);
    const wsPort = await readStreamPort(session, binaryPath);
    log(`[ab-relaunch] popOut returning wsPort=${wsPort}`);
    return { ok: true, ...(wsPort ? { wsPort } : {}) };
  }

  // The reverse: close the headed session and relaunch it headless at the active
  // URL, resuming the screencast.
  async function popIn(
    session: string,
    opts: { url?: string },
    binaryPath?: string,
  ): Promise<AgentBrowserPopResult> {
    if (typeof session !== 'string' || !session) return { ok: false, error: 'session is required' };
    const url = relaunchUrl(opts?.url);
    log(`[ab-relaunch] popIn session=${session} requestedUrl=${JSON.stringify(opts?.url)} -> open ${url}`);
    // Reverse of pop-out: the daemon is headed, so a plain `open` would reattach
    // to it and stay headed. Stop the daemon so the relaunch comes up headless.
    await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
    await killDaemon(session);
    // The headed window is gone after the close above; back to headless.
    poppedOutSessions.delete(session);
    const opened = await runWithBinaryFallback(['--session', session, 'open', url], binaryPath);
    log(`[ab-relaunch] popIn open exit=${opened.exitCode}${opened.stderr.trim() ? ` stderr=${opened.stderr.trim()}` : ''}`);
    if (opened.exitCode !== 0) {
      return { ok: false, error: opened.stderr.trim() || `open exited ${opened.exitCode}` };
    }
    await closeStrayBlankTabs(session, binaryPath);
    const wsPort = await readStreamPort(session, binaryPath);
    log(`[ab-relaunch] popIn returning wsPort=${wsPort}`);
    return { ok: true, ...(wsPort ? { wsPort } : {}) };
  }

  // Close every still-popped-out session's headed window. Called from each
  // host's shutdown (VS Code `deactivate()`, the sidecar's `shutdown()`) so
  // quitting doesn't orphan real Chrome windows. On a reload, a popped-out
  // surface then auto-reverts to a headless screencast when it reactivates
  // (spec → "The headed window ends → auto-revert"), which is preferable to
  // leaving a detached headed Chrome behind.
  async function closePoppedOut(): Promise<void> {
    const entries = [...poppedOutSessions.entries()];
    poppedOutSessions.clear();
    await Promise.all([
      ...entries.map(([session, binaryPath]) =>
        runWithBinaryFallback(['--session', session, 'close'], binaryPath).catch(() => undefined),
      ),
      // The same shutdown, so the same hook: this is the only moment both hosts
      // reliably reach, and every captured frame is still on disk until it runs.
      removeScreenshotDir(),
    ]);
  }

  return { command, edit, screenshot, screenshotToFile, streamStatus, open, popOut, popIn, closePoppedOut };
}
