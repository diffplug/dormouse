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
 * 2. `ensureStreamRelayPort` — a loopback-only TCP relay that strips the
 *    `Origin` header from WebSocket upgrade requests. The agent-browser stream
 *    server returns 403 for `vscode-webview://` origins (only localhost or
 *    absent origins are accepted), so the webview cannot connect directly; it
 *    connects to ws://127.0.0.1:<relayPort>/stream/<streamPort> instead and
 *    the relay pipes bytes to 127.0.0.1:<streamPort>.
 */
import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { log } from './log';

const ALLOWED_SUBCOMMANDS = new Set(['tab', 'set', 'screenshot', 'close']);

export interface AgentBrowserCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentBrowserEditOp = 'selectAll' | 'copy' | 'cut';

export interface AgentBrowserEditResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface AgentBrowserScreenshotResult {
  ok: boolean;
  bytes?: Uint8Array;
  mime?: string;
  error?: string;
}

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
// screencast) and return it base64-encoded. agent-browser writes a file and
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

export function ensureStreamRelayPort(): Promise<number> {
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

// The relay is loopback-only on both sides: it accepts connections from
// 127.0.0.1 and dials only 127.0.0.1:<port>. It rewrites the upgrade request
// head (path → "/", Origin dropped, Host rewritten) and from then on is a dumb
// byte pipe in both directions.
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
    const requestMatch = /^GET \/stream\/(\d{1,5}) HTTP\/1\.1\r\n/.exec(headText);
    const targetPort = requestMatch ? Number(requestMatch[1]) : 0;
    if (!targetPort || targetPort > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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
