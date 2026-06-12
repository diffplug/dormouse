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
import * as net from 'net';
import { spawn } from 'child_process';
import { log } from './log';

const ALLOWED_SUBCOMMANDS = new Set(['tab', 'close']);

export interface AgentBrowserCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runAgentBrowserCommand(session: string, args: string[]): Promise<AgentBrowserCommandResult> {
  if (typeof session !== 'string' || !session) {
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'session is required' });
  }
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: `agent-browser subcommand '${subcommand ?? ''}' is not allowed from the webview` });
  }

  const binary = process.env.DORMOUSE_AGENT_BROWSER_BIN || 'agent-browser';
  return new Promise((resolve) => {
    const child = spawn(binary, ['--session', session, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
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
