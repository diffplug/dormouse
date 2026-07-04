#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// cross-spawn, not node:child_process: this script spawns `pnpm` and
// `agent-browser`, which are `.cmd` shims on Windows that a bare-name spawn
// can't resolve (ENOENT) and Node >=22 won't run directly (EINVAL). cross-spawn
// handles both and is a no-op on POSIX. See docs/specs/dor-cli.md.
import spawn from 'cross-spawn';
import { createInterface } from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const standaloneDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(standaloneDir, '..');
const sidecarDir = path.join(standaloneDir, 'sidecar');
const sidecarScript = path.join(sidecarDir, 'main.js');
const dorBinDir = path.join(sidecarDir, 'dor-cli', 'bin');
const dorEntrypoint = path.join(sidecarDir, 'dor-cli', 'dist', 'dor.js');
const hostPort = Number(process.env.DORMOUSE_BROWSER_DEV_HOST_PORT || 1422);
const vitePort = Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 1420);
const browserSession = process.env.DORMOUSE_BROWSER_DEV_AB_SESSION || 'dormouse-dev-standalone';
const controlSocket = path.join(os.tmpdir(), `dormouse-${process.pid}-browser-dor.sock`);
const controlToken = Math.random().toString(36).slice(2);

const pending = new Map();
const sseClients = new Set();
let sidecar;
let vite;
let shuttingDown = false;
let requestSeq = 0;

function log(message) {
  console.error(`[dev:standalone:ab] ${message}`);
}

function sendSse(res, event, data) {
  const payload = JSON.stringify(data);
  res.write(`event: ${event}\n`);
  for (const line of payload.split(/\r?\n/)) res.write(`data: ${line}\n`);
  res.write('\n');
}

function broadcast(event, data) {
  for (const client of sseClients) sendSse(client, event, data);
}

function writeSidecar(event, data = {}) {
  sidecar?.stdin?.write(`${JSON.stringify({ event, data })}\n`);
}

function requestSidecar(event, data, responseEvent, pick, timeoutMs = 10000) {
  const requestId = `dev-${++requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${event} timed out`));
    }, timeoutMs);
    pending.set(requestId, {
      responseEvent,
      resolve: (payload) => {
        clearTimeout(timer);
        resolve(pick(payload));
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    writeSidecar(event, { ...data, requestId });
  });
}

const fireAndForget = {
  pty_spawn: ({ id, options }) => writeSidecar('pty:spawn', { id, options }),
  pty_write: ({ id, data }) => writeSidecar('pty:input', { id, data }),
  pty_resize: ({ id, cols, rows }) => writeSidecar('pty:resize', { id, cols, rows }),
  pty_kill: ({ id }) => writeSidecar('pty:kill', { id }),
  pty_request_init: () => writeSidecar('pty:requestInit'),
  dor_control_response: ({ response }) => writeSidecar('dor:controlResponse', response),
  kill_sidecar_now: () => shutdown(),
};

const invokeMap = {
  get_available_shells: (_args) => requestSidecar('pty:getShells', {}, 'pty:shells', (data) => data.shells ?? []),
  pty_get_cwd: ({ id }) => requestSidecar('pty:getCwd', { id }, 'pty:cwd', (data) => data.cwd ?? null),
  pty_get_open_ports: ({ id }) => requestSidecar('pty:getOpenPorts', { id }, 'pty:openPorts', (data) => data.ports ?? []),
  pty_get_scrollback: ({ id }) => requestSidecar('pty:getScrollback', { id }, 'pty:scrollback', (data) => data.data ?? null),
  read_clipboard_file_paths: () => requestSidecar('clipboard:readFiles', {}, 'clipboard:files', (data) => data.paths ?? null),
  read_clipboard_image_as_file_path: () => requestSidecar('clipboard:readImage', {}, 'clipboard:image', (data) => data.path ?? null),
  read_clipboard_text: () => requestSidecar('clipboard:readText', {}, 'clipboard:text', (data) => data.text ?? null),
  iframe_create_proxy_url: ({ target }) => requestSidecar('iframe:createProxyUrl', { target }, 'iframe:proxyUrl', (data) => data.result),
  agent_browser_command: ({ session, args, binaryPath }) => requestSidecar('agentBrowser:command', { session, args, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
  agent_browser_edit: ({ session, op, binaryPath }) => requestSidecar('agentBrowser:edit', { session, op, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
  agent_browser_screenshot: async ({ session, format, quality, binaryPath }) => {
    const result = await requestSidecar('agentBrowser:screenshot', { session, format, quality, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000);
    // The sidecar now returns a temp-file PATH (bytes stay off the stdio pipe).
    // Production reads that file in Rust; this dev bridge has no Rust, so read it
    // in Node and re-encode to the base64 the browser-sidecar adapter expects —
    // base64 over the dev WebSocket is fine.
    if (result && result.ok && typeof result.path === 'string') {
      const bytes = await readFile(result.path);
      return { ok: true, mime: result.mime, bytesBase64: bytes.toString('base64') };
    }
    return result;
  },
  agent_browser_stream_status: ({ session, binaryPath }) => requestSidecar('agentBrowser:streamStatus', { session, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
  agent_browser_open: ({ url, headed, binaryPath }) => requestSidecar('agentBrowser:open', { url, headed, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
  agent_browser_pop_out: ({ session, url, rect, binaryPath }) => requestSidecar('agentBrowser:popOut', { session, url, rect, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
  agent_browser_pop_in: ({ session, url, binaryPath }) => requestSidecar('agentBrowser:popIn', { session, url, binaryPath }, 'agentBrowser:result', (data) => data.result, 30000),
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function startHostServer() {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/__dormouse_dev_host/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        sseClients.add(res);
        sendSse(res, 'sidecar', { event: 'dev:connected', data: { pid: process.pid } });
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__dormouse_dev_host/send') {
        const { cmd, args } = await readJson(req);
        const fn = fireAndForget[cmd];
        if (!fn) throw new Error(`unknown send command ${cmd}`);
        fn(args || {});
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__dormouse_dev_host/invoke') {
        const { cmd, args } = await readJson(req);
        const fn = invokeMap[cmd];
        if (!fn) throw new Error(`unknown invoke command ${cmd}`);
        const result = await fn(args || {});
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__dormouse_dev_host/console') {
        const { level, args } = await readJson(req);
        console.error(`[browser ${level || 'log'}] ${(args || []).join(' ')}`);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(err instanceof Error ? err.message : String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(hostPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function startSidecar() {
  sidecar = spawn(process.execPath, [sidecarScript], {
    cwd: sidecarDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DORMOUSE_NODE: process.execPath,
      DORMOUSE_CLI_BIN: dorBinDir,
      DORMOUSE_CLI_JS: dorEntrypoint,
      DORMOUSE_CONTROL_SOCKET: controlSocket,
      DORMOUSE_CONTROL_TOKEN: controlToken,
    },
  });
  log(`sidecar pid=${sidecar.pid}`);
  log(`dor control socket: ${controlSocket}`);

  createInterface({ input: sidecar.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[sidecar stdout] ${line}`);
      return;
    }
    const event = msg.event;
    const data = msg.data ?? null;
    const requestId = data && typeof data.requestId === 'string' ? data.requestId : null;
    if (requestId) {
      const pendingRequest = pending.get(requestId);
      if (pendingRequest && pendingRequest.responseEvent === event) {
        pending.delete(requestId);
        if (typeof data.error === 'string') pendingRequest.reject(new Error(data.error));
        else pendingRequest.resolve(data);
        return;
      }
    }
    broadcast('sidecar', { event, data });
  });
  createInterface({ input: sidecar.stderr }).on('line', (line) => console.error(`[sidecar] ${line}`));
  sidecar.on('exit', (code, signal) => {
    log(`sidecar exited code=${code} signal=${signal}`);
    for (const request of pending.values()) request.reject(new Error('sidecar exited'));
    pending.clear();
    shutdown();
  });
}

function startVite() {
  vite = spawn('pnpm', ['--filter', 'dormouse-standalone', 'dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_DORMOUSE_BROWSER_DEV_HOST: `http://127.0.0.1:${hostPort}`,
      DORMOUSE_BROWSER_DEV_VITE_PORT: String(vitePort),
    },
  });
  createInterface({ input: vite.stdout }).on('line', (line) => console.error(`[vite] ${line}`));
  createInterface({ input: vite.stderr }).on('line', (line) => console.error(`[vite] ${line}`));
  vite.on('exit', (code, signal) => {
    log(`vite exited code=${code} signal=${signal}`);
    shutdown();
  });
}

async function waitForVite() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(vitePort, 'localhost', resolve);
        socket.once('error', reject);
        socket.once('connect', () => socket.end());
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`vite did not open port ${vitePort}`);
}

async function openAgentBrowser() {
  const args = ['--session', browserSession];
  if (process.env.DORMOUSE_BROWSER_DEV_HEADED === '1') args.push('--headed');
  args.push('open', `http://localhost:${vitePort}`);
  const child = spawn('agent-browser', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout }).on('line', (line) => console.error(`[agent-browser] ${line}`));
  createInterface({ input: child.stderr }).on('line', (line) => console.error(`[agent-browser] ${line}`));
  await new Promise((resolve) => child.on('exit', resolve));
  log(`agent-browser session: ${browserSession}`);
  log(`try: agent-browser --session ${browserSession} snapshot -i`);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of sseClients) client.end();
  sseClients.clear();
  if (vite && !vite.killed) vite.kill('SIGTERM');
  if (sidecar && !sidecar.killed) sidecar.kill('SIGTERM');
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`starting browser dev host on http://127.0.0.1:${hostPort}`);
await startHostServer();
startSidecar();
startVite();
await waitForVite();
await openAgentBrowser();
log('running; Ctrl-C to stop');
