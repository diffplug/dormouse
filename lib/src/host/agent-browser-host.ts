/**
 * Host-agnostic agent-browser support (docs/specs/dor-agent-browser.md →
 * "Host capabilities"). The single source of truth for both hosts:
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
 *    render swap (docs/specs/dor-iframe.md → "Path 1").
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
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
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
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          resolve('ENOENT');
          return;
        }
        log(`[agent-browser] spawn failed: ${err.message}`);
        resolve({ exitCode: 1, stdout: '', stderr: err.message });
      });
      child.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
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

  async function readCurrentUrl(session: string, binaryPath?: string): Promise<string | undefined> {
    const result = await runWithBinaryFallback(['--session', session, 'get', 'url'], binaryPath);
    if (result.exitCode !== 0) return undefined;
    return usableRelaunchUrl(result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0));
  }

  async function resolveRelaunchUrl(session: string, requestedUrl: unknown, binaryPath?: string): Promise<string> {
    // The webview's tab snapshot can lag behind the daemon, especially while
    // swapping headed/headless modes. Query the live session immediately before
    // closing it so pop-out/pop-in preserves the page the user is actually on.
    return (await readCurrentUrl(session, binaryPath)) ?? usableRelaunchUrl(requestedUrl) ?? 'about:blank';
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
  // to a live screencast (docs/specs/dor-iframe.md → "Path 1"). With `headed`,
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
    const url = await resolveRelaunchUrl(session, opts?.url, binaryPath);
    await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
    const opened = await runWithBinaryFallback(['--session', session, '--headed', 'open', url], binaryPath);
    if (opened.exitCode !== 0) {
      return { ok: false, error: opened.stderr.trim() || `headed open exited ${opened.exitCode}` };
    }
    // Now a real headed OS window — track it so shutdown can close it.
    poppedOutSessions.set(session, binaryPath);
    const wsPort = await readStreamPort(session, binaryPath);
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
    const url = await resolveRelaunchUrl(session, opts?.url, binaryPath);
    await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
    // The headed window is gone after the close above; back to headless.
    poppedOutSessions.delete(session);
    const opened = await runWithBinaryFallback(['--session', session, 'open', url], binaryPath);
    if (opened.exitCode !== 0) {
      return { ok: false, error: opened.stderr.trim() || `open exited ${opened.exitCode}` };
    }
    const wsPort = await readStreamPort(session, binaryPath);
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
