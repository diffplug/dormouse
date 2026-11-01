#!/usr/bin/env node
/**
 * Does a real phone run a frame origin? (docs/specs/pocket-app.md -> scope
 * pocket-frames). Serves a page standing in for Pocket and a frame origin, on
 * two loopback ports, using the shipped worker, bootstrap page, bridge, socket
 * shim and Hosted handler. Nothing here reaches a Burrow or reads pairing data.
 *
 *   pnpm --filter dormouse-lib build:frame-origin
 *   node scripts/frame-origin-check/serve.mjs --pocket-origin <https url> --frame-origin <https url> --reports <dir>
 *
 * Point each origin at its port with whatever gives a phone HTTPS. For the
 * cross-site case they must be different sites. Each finished run is written to
 * `--reports` and printed.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { values } = parseArgs({
  options: {
    'pocket-origin': { type: 'string' },
    'frame-origin': { type: 'string' },
    'pocket-port': { type: 'string', default: '47321' },
    'frame-port': { type: 'string', default: '47322' },
    reports: { type: 'string' },
  },
});
const pocketOrigin = values['pocket-origin'] ?? `http://localhost:${values['pocket-port']}`;
const frameOrigin = values['frame-origin'] ?? `http://127.0.0.1:${values['frame-port']}`;
const reports = values.reports ?? join(root, '.frame-origin-check');
mkdirSync(reports, { recursive: true });

const ASSETS = join(root, 'lib', 'dist-frame-origin');
if (!existsSync(join(ASSETS, '__dormouse-frame-sw.js'))) {
  console.error('Run `pnpm --filter dormouse-lib build:frame-origin` first.');
  process.exit(1);
}

const { build } = createRequire(join(root, 'standalone', 'package.json'))('esbuild');
const nodePaths = [join(root, 'lib', 'node_modules'), join(root, 'hosted', 'node_modules')];
const bundle = async (entry, options) => (await build({
  entryPoints: [entry], bundle: true, write: false, logLevel: 'error', nodePaths, ...options,
})).outputFiles[0].text;
const checkPage = await bundle(join(here, 'check-page.ts'), {
  format: 'iife', target: 'es2020', define: { FRAMED_PAGE: JSON.stringify(readFileSync(join(here, 'framed-page.js'), 'utf8')) },
});
const handlerSource = await bundle(join(root, 'hosted', 'server', 'frame-origin.ts'), { format: 'esm', platform: 'neutral', mainFields: ['module', 'main'] });
const { frameOriginResponse } = await import(`data:text/javascript;base64,${Buffer.from(handlerSource).toString('base64')}`);

const SHELL = `<!doctype html><html data-frame-origin="${frameOrigin}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.webmanifest">
<title>Frame check</title><style>
body{font:15px -apple-system,system-ui,sans-serif;margin:12px}h1{font-size:20px}ul{padding:0;list-style:none}
li{padding:6px 0;border-bottom:1px solid #ccc;word-break:break-word}.pass{color:#0a7a2f}.fail{color:#c11;font-weight:600}
iframe{width:100%;height:60px;border:1px solid #999}</style></head>
<body><h1 id="headline">Running…</h1><ul id="list"></ul><script src="/check.js"></script></body></html>`;
const MANIFEST = JSON.stringify({ name: 'Frame check', short_name: 'Frame check', start_url: '/', scope: '/', display: 'standalone', icons: [] });

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
};

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, pocketOrigin);
  if (pathname === '/') return send(res, 200, 'text/html; charset=utf-8', SHELL);
  if (pathname === '/check.js') return send(res, 200, 'text/javascript', checkPage);
  if (pathname === '/manifest.webmanifest') return send(res, 200, 'application/manifest+json', MANIFEST);
  if (pathname === '/report' && req.method === 'POST') {
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size <= 256 * 1024) parts.push(part);
    });
    req.on('end', () => {
      if (size > 256 * 1024) return send(res, 413, 'text/plain', 'too large');
      const report = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const file = join(reports, `${Date.now()}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\n${report.standalone ? 'HOME SCREEN' : 'TAB'}  ${report.userAgent}\n${report.failed} failed; ${file}`);
      for (const result of report.results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
      send(res, 204, 'text/plain', '');
    });
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(Number(values['pocket-port']), '127.0.0.1');

// The shipped handler, over the shipped build; only the probe is added.
const assets = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = join(ASSETS, pathname.endsWith('/bootstrap') ? `${pathname}.html` : pathname);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response('', { status: 404 });
  },
};
const PROBE_HEADERS = {
  'content-security-policy': `frame-ancestors ${pocketOrigin}`, 'x-content-type-options': 'nosniff',
};
http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, frameOrigin);
  if (pathname === '/__dormouse-frame/probe.html') return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(here, 'probe.html')), PROBE_HEADERS);
  if (pathname === '/__dormouse-frame/probe.js') return send(res, 200, 'text/javascript', readFileSync(join(here, 'probe.js')), PROBE_HEADERS);
  const response = await frameOriginResponse(new Request(new URL(req.url, frameOrigin), { method: req.method }), { ASSETS: assets, CLIENT_ORIGIN: pocketOrigin });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(values['frame-port']), '127.0.0.1');

console.log(`Pocket stand-in ${pocketOrigin} -> 127.0.0.1:${values['pocket-port']}\nFrame origin    ${frameOrigin} -> 127.0.0.1:${values['frame-port']}\nReports in      ${reports}`);
