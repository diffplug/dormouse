/**
 * Extension-host wiring for the agent-browser surface
 * (docs/specs/dor-browser.md → "Agent-browser host capabilities").
 *
 * The capability logic itself is host-agnostic and lives in
 * `lib/src/host/agent-browser-host.ts` (shared verbatim with the standalone
 * Node sidecar). This file only:
 *   1. instantiates that shared host with the two VS-Code-specific bits —
 *      writing the OS clipboard and logging — and re-exports its methods; and
 *   2. owns the **stream relay**, which is genuinely VS-Code-only: the
 *      agent-browser stream server returns 403 for `vscode-webview://` origins
 *      (only localhost or absent origins are accepted), so the webview cannot
 *      connect directly. It connects to a short-lived tokenized relay URL and
 *      the relay pipes bytes only to the authorized 127.0.0.1:<streamPort>.
 *      (The standalone webview's `tauri://localhost` origin is accepted, so it
 *      connects directly and needs no relay.)
 */
import * as vscode from 'vscode';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { log } from './log';
import { createAgentBrowserHost } from '../../lib/src/host/agent-browser-host';

const host = createAgentBrowserHost({
  writeClipboardText: (text) => vscode.env.clipboard.writeText(text),
  log: (message) => log.info(message),
});

export const runAgentBrowserCommand = host.command;
export const runAgentBrowserEdit = host.edit;
export const runAgentBrowserScreenshot = host.screenshot;
export const runAgentBrowserStreamStatus = host.streamStatus;
export const runAgentBrowserOpen = host.open;
export const runAgentBrowserPopOut = host.popOut;
export const runAgentBrowserPopIn = host.popIn;
export const closePoppedOutSessions = host.closePoppedOut;

const STREAM_RELAY_TOKEN_BYTES = 32;
const STREAM_RELAY_GRANT_TTL_MS = 60_000;
const STREAM_RELAY_GRANT_SWEEP_MS = 30_000;

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
