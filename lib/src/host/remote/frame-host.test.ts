/**
 * The Node frame host against a real upstream, through the real iframe proxy:
 * a Client's request reaches the page as a loopback caller's would, and what
 * comes back is told in the frame origin's terms.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { HttpHeader } from 'remote-lib-common';
import type { FrameHttpInit, FrameUpstream } from '../../remote/burrow/burrow-frame-host';
import { createIframeProxyUrl, isUpstreamOnThisMachine, releaseIframeProxyLease } from '../iframe-proxy';
import { createBurrowFrameHost } from './frame-host';

const proxy = { create: createIframeProxyUrl, release: releaseIframeProxyLease, isLocal: (url: string) => isUpstreamOnThisMachine(url) };

const FRAME_ORIGIN = 'https://frame.example';
const POCKET = ['https://pocket.example'];
const servers: Array<{ close(): void }> = [];
const upstreams: FrameUpstream[] = [];

afterEach(() => {
  for (const upstream of upstreams.splice(0)) upstream.close();
  for (const server of servers.splice(0)) server.close();
});

function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ port: typeof address === 'object' && address ? address.port : 0, server });
  }));
}

let leases = 0;
async function open(url: string): Promise<FrameUpstream> {
  const opened = await createBurrowFrameHost(proxy).open(url, {
    frameOrigin: FRAME_ORIGIN,
    embedderOrigins: POCKET,
    lease: { owner: 'remote:test', id: `f${++leases}` },
  });
  if ('refused' in opened) throw new Error(opened.refused);
  upstreams.push(opened);
  return opened;
}

interface Response { status: number; headers: HttpHeader[]; body: string }
function fetchThrough(upstream: FrameUpstream, init: FrameHttpInit, body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    let head: Omit<Response, 'body'> | null = null;
    const chunks: Uint8Array[] = [];
    const exchange = upstream.request(init, {
      onHead: (status, _text, headers) => { head = { status, headers }; },
      onBody: (chunk) => chunks.push(chunk.slice()),
      onEnd: () => resolve({ ...head!, body: Buffer.concat(chunks).toString('utf8') }),
      onError: (message) => reject(new Error(message)),
    });
    exchange.write(new TextEncoder().encode(body ?? ''), true).catch(reject);
  });
}

const header = (headers: HttpHeader[], name: string) => headers.find(([n]) => n.toLowerCase() === name)?.[1];

describe('createBurrowFrameHost', () => {
  it('serves the instrumented page, framed for the Client\'s chain, at the path it opened', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
      res.end('<html><head><title>t</title></head><body>hi</body></html>');
    });
    const upstream = await open(`http://localhost:${port}/app?x=1#top`);
    expect(upstream.path).toBe('/app?x=1#top');
    const response = await fetchThrough(upstream, { method: 'GET', path: '/app?x=1', headers: [], destination: 'iframe' });
    expect(response.status).toBe(200);
    expect(header(response.headers, 'x-frame-options')).toBeUndefined();
    expect(header(response.headers, 'content-security-policy')).toBe("frame-ancestors 'self' https://pocket.example");
    // The shim, addressed to the Client's page.
    expect(response.body).toContain('https://pocket.example');
    expect(response.body).toContain('<body>hi</body>');
    expect(response.body).toContain('window.WebSocket=T');
  });

  it('vouches only for the frame origin, keeps redirects on the frame, and drops cookies', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const { port } = await listen((req, res) => {
      seen = req.headers;
      res.writeHead(302, { location: `http://localhost:${port}/next?a=1`, 'set-cookie': 'id=1' });
      res.end();
    });
    const upstream = await open(`http://localhost:${port}/`);
    const own = await fetchThrough(upstream, {
      method: 'POST',
      path: '/form',
      headers: [['origin', FRAME_ORIGIN], ['referer', `${FRAME_ORIGIN}/page`], ['cookie', 'a=b'], ['content-type', 'text/plain']],
      destination: '',
    }, 'payload');
    expect(seen.origin).toBe(`http://localhost:${port}`);
    expect(seen.referer).toBe(`http://localhost:${port}/page`);
    expect(seen.cookie).toBeUndefined();
    expect(seen['sec-fetch-dest']).toBe('empty');
    expect(header(own.headers, 'location')).toBe('/next?a=1');
    expect(header(own.headers, 'set-cookie')).toBeUndefined();

    await fetchThrough(upstream, { method: 'POST', path: '/form', headers: [['origin', 'https://evil.example']] });
    expect(seen.origin).toBe('https://evil.example');
  });

  it('sends a request body through, and decodes a body the upstream compressed anyway', async () => {
    const { port } = await listen((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(JSON.stringify({ got: Buffer.concat(parts).toString('utf8'), ae: req.headers['accept-encoding'] })));
      });
    });
    const upstream = await open(`http://localhost:${port}/`);
    const response = await fetchThrough(upstream, { method: 'PUT', path: '/save', headers: [], destination: '' }, 'file text');
    expect(JSON.parse(response.body)).toEqual({ got: 'file text', ae: 'identity' });
    expect(header(response.headers, 'content-encoding')).toBeUndefined();
  });

  it('frames only a page on this machine, and lists accordingly', async () => {
    const host = createBurrowFrameHost({
      ...proxy,
      create: (url, options) => createIframeProxyUrl(url, {
        ...options,
        resolve: async (name) => (name === 'remote.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
      }),
    });
    const lease = { owner: 'remote:test', id: 'off-machine' };
    expect(await host.open('http://remote.example/', { frameOrigin: FRAME_ORIGIN, embedderOrigins: POCKET, lease }))
      .toEqual({ refused: 'a remote device frames pages on this machine only' });
    const { port } = await listen((_req, res) => res.end('ok'));
    expect(await host.canOpen(`http://localhost:${port}/`)).toBe(true);
    expect(await host.canOpen('https://localhost/')).toBe(false);
  });

  it('refuses a page the proxy refuses, and an unusable chain', async () => {
    const host = createBurrowFrameHost(proxy);
    const lease = { owner: 'remote:test', id: 'refused' };
    expect(await host.open('http://169.254.169.254/', { frameOrigin: FRAME_ORIGIN, embedderOrigins: POCKET, lease }))
      .toEqual({ refused: 'link-local / metadata addresses are refused' });
    expect(await host.open('http://localhost:1/', { frameOrigin: FRAME_ORIGIN, embedderOrigins: ['null'], lease }))
      .toEqual({ refused: 'invalid embedder origins' });
    expect(await host.open('http://localhost:1/', { frameOrigin: 'https://a.example/path', embedderOrigins: POCKET, lease }))
      .toEqual({ refused: 'invalid frame origin' });
  });

  it('tunnels a WebSocket to the page, as the grant\'s own origin', async () => {
    const { port, server } = await listen(() => {});
    const wss = new WebSocketServer({ server });
    servers.push(wss);
    let origin: string | undefined;
    wss.on('connection', (socket, req) => {
      origin = req.headers.origin;
      socket.on('message', (data, binary) => socket.send(binary ? data : `echo:${data.toString()}`));
    });
    const upstream = await open(`http://localhost:${port}/`);
    const messages: string[] = [];
    const closed = new Promise<number>((resolve) => {
      const socket = upstream.openSocket({ path: '/hmr', protocols: [] }, {
        onOpen: () => { void socket.send(new TextEncoder().encode('ping'), false); },
        onMessage: (data) => {
          messages.push(new TextDecoder().decode(data));
          socket.close(1000, 'done');
        },
        onClose: (code) => resolve(code),
      });
    });
    expect(await closed).toBe(1000);
    expect(messages).toEqual(['echo:ping']);
    expect(origin).toBe(`http://localhost:${port}`);
  });

  it('closing the upstream ends its grant and what is in flight on it', async () => {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    let ended!: () => void;
    const dropped = new Promise<void>((resolve) => { ended = resolve; });
    const { port } = await listen((req) => {
      // Holds the response, so only the close can end the exchange.
      req.socket.on('close', () => ended());
      arrived();
    });
    const upstream = await open(`http://localhost:${port}/`);
    let heard = false;
    const exchange = upstream.request({ method: 'GET', path: '/', headers: [] }, {
      onHead: () => { heard = true; },
      onBody: () => { heard = true; },
      onEnd: () => { heard = true; },
      onError: () => { heard = true; },
    });
    await exchange.write(new Uint8Array(0), true);
    await reached;
    upstream.close();
    await dropped;
    expect(heard).toBe(false);
  });
});
