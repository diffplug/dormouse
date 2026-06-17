/**
 * Extension-host support for the agent-browser surface
 * (docs/specs/dor-agent-browser.md → "Host capabilities").
 *
 * Two narrow capabilities, both on behalf of the webview:
 *
 * 1. `runAgentBrowserCommand` — runs the user's agent-browser binary against a
 *    session for tab actions and session teardown. Subcommands are
 *    allowlisted; this is not a general exec channel.
 *
 * 2. `createStreamRelayUrl` — a loopback-only TCP relay that strips the
 *    `Origin` header from WebSocket upgrade requests. The agent-browser stream
 *    server returns 403 for `vscode-webview://` origins (only localhost or
 *    absent origins are accepted), so the webview cannot connect directly; it
 *    connects to a short-lived tokenized relay URL instead and the relay pipes
 *    bytes only to the authorized 127.0.0.1:<streamPort>.
 */
import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { log } from './log';
import {
  AGENT_BROWSER_ALLOWED_SUBCOMMANDS,
  type AgentBrowserCommandResult,
  type AgentBrowserEditOp,
  type AgentBrowserEditResult,
  type AgentBrowserOpenResult,
  type AgentBrowserPopResult,
  type AgentBrowserScreenshotResult,
} from '../../lib/src/lib/platform/types';

const ALLOWED_SUBCOMMANDS = new Set<string>(AGENT_BROWSER_ALLOWED_SUBCOMMANDS);
const STREAM_RELAY_TOKEN_BYTES = 32;
const STREAM_RELAY_GRANT_TTL_MS = 60_000;
const STREAM_RELAY_GRANT_SWEEP_MS = 30_000;

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. copy/cut return the
// selected text; selectAll returns ''. Inputs/textareas use selection ranges;
// everything else falls back to the Selection API + execCommand.
const EDIT_SCRIPTS: Record<AgentBrowserEditOp, string> = {
  selectAll: `(()=>{const el=document.activeElement;if(el&&'select'in el&&'value'in el){el.select();}else{document.execCommand('selectAll');}return'';})()`,
  copy: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){return el.value.slice(el.selectionStart,el.selectionEnd);}return String(window.getSelection()||'');})()`,
  cut: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){const s=el.selectionStart,e=el.selectionEnd,t=el.value.slice(s,e);el.setRangeText('',s,e,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return t;}const sel=String(window.getSelection()||'');if(sel)document.execCommand('delete');return sel;})()`,
};

export async function runAgentBrowserCommand(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
  if (typeof session !== 'string' || !session) {
    return { exitCode: 1, stdout: '', stderr: 'session is required' };
  }
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return { exitCode: 1, stdout: '', stderr: `agent-browser subcommand '${subcommand ?? ''}' is not allowed from the webview` };
  }
  return runWithBinaryFallback(['--session', session, ...args], binaryPath);
}

export async function runAgentBrowserEdit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult> {
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
  if (text) await vscode.env.clipboard.writeText(text);
  return { ok: true, text };
}

// Reused per session so we don't litter tmp with one file per frame; the panel
// guarantees one screenshot in flight per surface, so overwriting is safe.
function screenshotPath(session: string, ext: string): string {
  const safe = session.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(os.tmpdir(), `dormouse-ab-shot-${safe}.${ext}`);
}

// Capture one device-resolution frame via the user's agent-browser `screenshot`
// command (which honors the session's viewport/DPR, unlike the CSS-resolution
// screencast) and return the raw image bytes. agent-browser writes a file and
// reports the path; we read it back and hand the bytes to the webview.
export async function runAgentBrowserScreenshot(
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
    log.info(`[agent-browser] screenshot failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    return { ok: false, error: result.stderr.trim() || `screenshot exited ${result.exitCode}` };
  }
  try {
    const buffer = await fs.readFile(out);
    // A Uint8Array view over exactly this file's bytes; structured-clone copies
    // it across the webview boundary (no base64 round-trip).
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return { ok: true, bytes, mime: format === 'png' ? 'image/png' : 'image/jpeg' };
  } catch (err) {
    log.info(`[agent-browser] screenshot read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: `could not read screenshot file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const STREAM_PORT_READ_ATTEMPTS = 4;
const STREAM_PORT_READ_DELAY_MS = 150;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Read a session's stream WebSocket port via `stream status --json`. Mirrors
// the parse in dor/src/commands/agent-browser.ts: { port } or { data: { port } }.
// Right after `open` / `--headed open` (a fresh spawn, a pop-out, or a pop-in
// relaunch) the daemon may not have published the port yet; a single read would
// then return undefined and leave the panel pinned to a stale port — it reads
// "ended" though the session is live. Retry briefly to close that window.
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

// A fresh managed session for a surface spawned from the GUI (no `--key`),
// mirroring `dor ab`'s `dormouse.<workspaceId>.<key>` namespacing so it can't
// collide with a user's own agent-browser sessions.
function generateGuiSession(): string {
  return `dormouse.1.gui-${randomBytes(6).toString('hex')}`;
}

// Spawn a managed session and open <url> — backs swapping an iframe embed up to
// a live screencast (docs/specs/dor-iframe.md → "Path 1"). With `headed`, the
// process launches headed in one shot so embed→popout doesn't open a headless
// browser only to tear it down. Mirrors what `dor ab open <url>` does, but
// driven from the GUI rather than a terminal.
export async function runAgentBrowserOpen(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult> {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'url is required' };
  const session = generateGuiSession();
  const args = ['--session', session, ...(opts?.headed ? ['--headed'] : []), 'open', url];
  const open = await runWithBinaryFallback(args, binaryPath);
  if (open.exitCode !== 0) {
    return { ok: false, error: open.stderr.trim() || `open exited ${open.exitCode}` };
  }
  const wsPort = await readStreamPort(session, binaryPath);
  return { ok: true, session, ...(wsPort ? { wsPort } : {}), ...(binaryPath ? { binaryPath } : {}) };
}

// Pop-out is a relaunch, not a live toggle: Chrome's headed/headless choice is
// fixed at launch (spec → "Headed Pop-Out"). Close the headless session, then
// reopen it headed at the active URL. (v1 preserves the active tab URL only;
// multi-tab + profile/cookie restore are tracked follow-ups. Window
// positioning over opts.rect is deferred — VS Code can't read screen coords, so
// the window opens where Chrome places it.)
export async function runAgentBrowserPopOut(
  session: string,
  opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string },
  binaryPath?: string,
): Promise<AgentBrowserPopResult> {
  if (typeof session !== 'string' || !session) return { ok: false, error: 'session is required' };
  await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
  const url = typeof opts?.url === 'string' && opts.url ? opts.url : 'about:blank';
  const open = await runWithBinaryFallback(['--session', session, '--headed', 'open', url], binaryPath);
  if (open.exitCode !== 0) {
    return { ok: false, error: open.stderr.trim() || `headed open exited ${open.exitCode}` };
  }
  const wsPort = await readStreamPort(session, binaryPath);
  return { ok: true, ...(wsPort ? { wsPort } : {}) };
}

// The reverse: close the headed session and relaunch it headless at the active
// URL, resuming the screencast.
export async function runAgentBrowserPopIn(
  session: string,
  opts: { url?: string },
  binaryPath?: string,
): Promise<AgentBrowserPopResult> {
  if (typeof session !== 'string' || !session) return { ok: false, error: 'session is required' };
  await runWithBinaryFallback(['--session', session, 'close'], binaryPath);
  const url = typeof opts?.url === 'string' && opts.url ? opts.url : 'about:blank';
  const open = await runWithBinaryFallback(['--session', session, 'open', url], binaryPath);
  if (open.exitCode !== 0) {
    return { ok: false, error: open.stderr.trim() || `open exited ${open.exitCode}` };
  }
  const wsPort = await readStreamPort(session, binaryPath);
  return { ok: true, ...(wsPort ? { wsPort } : {}) };
}

// The extension host's PATH is often the GUI login PATH (no nvm/volta shims),
// so prefer the absolute path `dor ab` resolved in the user's terminal; fall
// through on ENOENT in case it has gone stale.
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
    log.info(`[agent-browser] ${lastError}; trying next candidate`);
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
      log.info(`[agent-browser] spawn failed: ${err.message}`);
      resolve({ exitCode: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

let relayPortPromise: Promise<number> | null = null;
const streamRelayGrants = new Map<string, { port: number; expiresAt: number }>();
let lastStreamRelayGrantSweep = 0;

export async function createStreamRelayUrl(streamPort: number): Promise<string> {
  const relayPort = await ensureStreamRelayPort();
  const token = randomBytes(STREAM_RELAY_TOKEN_BYTES).toString('hex');
  const now = Date.now();
  sweepStreamRelayGrants(now);
  streamRelayGrants.set(token, { port: streamPort, expiresAt: now + STREAM_RELAY_GRANT_TTL_MS });
  return `ws://127.0.0.1:${relayPort}/stream/${streamPort}/${token}`;
}

function ensureStreamRelayPort(): Promise<number> {
  if (!relayPortPromise) {
    relayPortPromise = new Promise<number>((resolve, reject) => {
      const server = net.createServer(handleRelayClient);
      server.on('error', (err) => {
        log.info(`[agent-browser] stream relay error: ${err.message}`);
        relayPortPromise = null;
        reject(err);
      });
      server.unref();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          log.info(`[agent-browser] stream relay listening on 127.0.0.1:${address.port}`);
          resolve(address.port);
        } else {
          reject(new Error('stream relay failed to bind'));
        }
      });
    });
  }
  return relayPortPromise;
}

function sweepStreamRelayGrants(now = Date.now()): void {
  if (now - lastStreamRelayGrantSweep < STREAM_RELAY_GRANT_SWEEP_MS) return;
  lastStreamRelayGrantSweep = now;
  for (const [token, grant] of streamRelayGrants) {
    if (grant.expiresAt <= now) streamRelayGrants.delete(token);
  }
}

function consumeStreamRelayGrant(token: string, port: number): boolean {
  const now = Date.now();
  sweepStreamRelayGrants(now);
  const grant = streamRelayGrants.get(token);
  if (!grant) return false;
  streamRelayGrants.delete(token);
  return grant.expiresAt > now && grant.port === port;
}

// The relay is loopback-only on both sides: it accepts connections from
// 127.0.0.1 and dials only an explicitly granted 127.0.0.1:<port>. It rewrites
// the upgrade request head (path → "/", Origin dropped, Host rewritten) and
// from then on is a dumb byte pipe in both directions.
function handleRelayClient(client: net.Socket): void {
  let head = Buffer.alloc(0);
  client.on('error', () => {});

  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const headEnd = head.indexOf('\r\n\r\n');
    if (headEnd === -1) {
      if (head.length > 16384) client.destroy();
      return;
    }
    client.off('data', onData);
    client.pause();

    const headText = head.subarray(0, headEnd).toString('latin1');
    const remainder = head.subarray(headEnd + 4);
    const requestMatch = /^GET \/stream\/(\d{1,5})\/([a-f0-9]{64}) HTTP\/1\.1\r\n/i.exec(headText);
    const targetPort = requestMatch ? Number(requestMatch[1]) : 0;
    if (!targetPort || targetPort > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const token = requestMatch?.[2] ?? '';
    if (!consumeStreamRelayGrant(token, targetPort)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const headerLines = headText.split('\r\n').slice(1).filter((line) => {
      const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
      return name !== 'origin';
    }).map((line) => (
      line.toLowerCase().startsWith('host:') ? `Host: 127.0.0.1:${targetPort}` : line
    ));
    const rewritten = `GET / HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`;

    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      upstream.write(rewritten);
      if (remainder.length) upstream.write(remainder);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  };

  client.on('data', onData);
}
