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
 * 7. `closePoppedOut` — close every still-headed window, called from each host's
 *    shutdown so quitting never orphans a real Chrome window.
 *
 * The VS Code stream relay is NOT here: it works around the `vscode-webview://`
 * origin the agent-browser stream server rejects, which is a VS-Code-only
 * concern (the standalone webview's `tauri://localhost` origin is accepted, so
 * it connects directly). It stays in the VS Code host.
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
// cross-spawn, not child_process — on Windows a bare command name never resolves
// a `.cmd`/`.bat` PATH shim (Node spawn ignores PATHEXT → ENOENT), and Node >=22
// refuses to spawn a `.cmd` directly even by full path (EINVAL, the
// CVE-2024-27980 hardening). agent-browser ships as a `.cmd` shim, so both bite;
// the GUI host hits this even for the absolute `binaryPath` dor ab resolved.
// cross-spawn routes through cmd.exe with correct escaping and is a no-op on
// POSIX. See docs/specs/dor-cli.md → "Spawning External Binaries".
import spawn from 'cross-spawn';
import { randomBytes } from 'crypto';
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
// Grace for 'close' to fire after 'exit' before resolving anyway, so a daemon
// holding the inherited stdio pipes can't hang the spawn. See spawnAgentBrowser.
const CLOSE_GRACE_MS = 250;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AgentBrowserHostDeps {
  /** Write text to the OS clipboard (copy/cut land here). VS Code passes
   *  `vscode.env.clipboard.writeText`; the sidecar shells out (pbcopy/clip/…). */
  writeClipboardText: (text: string) => Promise<void> | void;
  /** Optional diagnostic logger. */
  log?: (message: string) => void;
}

export interface AgentBrowserHost {
  command(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult>;
  edit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult>;
  screenshot(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult>;
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
  // close it on shutdown or it orphans (spec → "Headed Pop-Out" lifecycle:
  // "Dormouse/editor quits → headed windows are cleaned up; no orphans").
  // Headless sessions are deliberately NOT tracked — they're left alive to
  // reattach across webview reloads (the wsPort/stream-recovery design).
  const poppedOutSessions = new Map<string, string | undefined>();

  // The host's PATH is often the GUI login PATH (no nvm/volta shims), so prefer
  // the absolute path `dor ab` resolved in the user's terminal; fall through on
  // ENOENT in case it has gone stale.
  async function runWithBinaryFallback(args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
    const candidates = [...new Set([
      binaryPath,
      process.env.DORMOUSE_AGENT_BROWSER_BIN,
      'agent-browser',
    ].filter((c): c is string => !!c))];

    let lastError = '';
    for (const binary of candidates) {
      const result = await spawnAgentBrowser(binary, args);
      if (result !== 'ENOENT') return result;
      lastError = `'${binary}' was not found`;
      log(`[agent-browser] ${lastError}; trying next candidate`);
    }
    return { exitCode: 1, stdout: '', stderr: `agent-browser binary not found (${lastError})` };
  }

  function spawnAgentBrowser(binary: string, args: string[]): Promise<AgentBrowserCommandResult | 'ENOENT'> {
    return new Promise((resolve) => {
      // windowsHide: cross-spawn runs `.cmd` shims through cmd.exe; without this
      // each spawn flashes a console window that steals focus. No-op off Windows.
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (apply: () => void): void => {
        if (settled) return;
        settled = true;
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        apply();
      };
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err: NodeJS.ErrnoException) => settle(() => {
        if (err.code === 'ENOENT') {
          resolve('ENOENT');
          return;
        }
        log(`[agent-browser] spawn failed: ${err.message}`);
        resolve({ exitCode: 1, stdout: '', stderr: err.message });
      }));
      const finish = (code: number | null): void => settle(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
      // Resolve on 'close' (clean: process exited and stdio drained), but fall
      // back to 'exit' because `agent-browser open` leaves a detached daemon that
      // on Windows inherits these pipes, so they never reach EOF and 'close' never
      // fires. The grace lets 'close' win first so normal commands keep full
      // output. See dor/src/commands/agent-browser.ts for the matching rationale.
      child.on('close', (code) => finish(code));
      child.on('exit', (code) => {
        graceTimer = setTimeout(() => finish(code), CLOSE_GRACE_MS);
      });
    });
  }

  // Read a session's stream WebSocket port via `stream status --json`. Mirrors
  // the parse in dor/src/commands/agent-browser.ts: { port } or { data: { port } }.
  // Right after `open` / `--headed open` (a fresh spawn, a pop-out, or a pop-in
  // relaunch) the daemon may not have published the port yet; a single read
  // would then return undefined and leave the panel pinned to a stale port — it
  // reads "ended" though the session is live. Retry briefly to close that window.
  async function readStreamPort(session: string, binaryPath?: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < STREAM_PORT_READ_ATTEMPTS; attempt++) {
      const result = await runWithBinaryFallback(['--session', session, 'stream', 'status', '--json'], binaryPath);
      if (result.exitCode === 0) {
        try {
          const parsed = JSON.parse(result.stdout) as { port?: unknown; data?: { port?: unknown } };
          const port = parsed.data?.port ?? parsed.port;
          if (typeof port === 'number' && Number.isFinite(port)) return port;
        } catch {
          // malformed output — fall through and retry
        }
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
  // mirroring `dor ab`'s `dormouse.<workspaceId>.<key>` namespacing so it can't
  // collide with a user's own agent-browser sessions.
  function generateGuiSession(): string {
    return `dormouse.1.gui-${randomBytes(6).toString('hex')}`;
  }

  // Reused per session so we don't litter tmp with one file per frame; the panel
  // guarantees one screenshot in flight per surface, so overwriting is safe.
  function screenshotPath(session: string, ext: string): string {
    const safe = session.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(os.tmpdir(), `dormouse-ab-shot-${safe}.${ext}`);
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
  // CSS-resolution screencast) and return the raw image bytes. agent-browser
  // writes a file and reports the path; we read it back and hand the bytes to
  // the caller (the VS Code host structured-clones them to the webview; the
  // sidecar base64s them over stdio to Rust, which returns a raw Response).
  async function screenshot(
    session: string,
    opts: { format?: 'jpeg' | 'png'; quality?: number },
    binaryPath?: string,
  ): Promise<AgentBrowserScreenshotResult> {
    if (typeof session !== 'string' || !session) {
      return { ok: false, error: 'session is required' };
    }
    const format = opts.format === 'png' ? 'png' : 'jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';
    const out = screenshotPath(session, ext);
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
    try {
      const buffer = await fs.readFile(out);
      // A Uint8Array view over exactly this file's bytes.
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return { ok: true, bytes, mime: format === 'png' ? 'image/png' : 'image/jpeg' };
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
  // fixed at launch (spec → "Headed Pop-Out"). Close the headless session, then
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
    await Promise.all(entries.map(([session, binaryPath]) =>
      runWithBinaryFallback(['--session', session, 'close'], binaryPath).catch(() => undefined),
    ));
  }

  return { command, edit, screenshot, streamStatus, open, popOut, popIn, closePoppedOut };
}
