import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startFileViewer } from '../../../dor/src/file-viewer';
import { createIframeProxyUrl } from './iframe-proxy';

const EMBEDDERS = ['vscode-webview://viewer-test', 'vscode-file://vscode-app'];
let root: string;
const viewers: Awaited<ReturnType<typeof startFileViewer>>[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dor-viewer-proxy-')); });
afterEach(async () => {
  await Promise.all(viewers.splice(0).map(viewer => viewer.close()));
  await rm(root, { recursive: true, force: true });
});

async function frame(name: string, contents: string) {
  const file = join(root, name);
  await writeFile(file, contents);
  const viewer = await startFileViewer(file);
  viewers.push(viewer);
  const result = await createIframeProxyUrl(`http://127.0.0.1:${viewer.port}${viewer.path}`, { embedderOrigins: EMBEDDERS });
  if (!result.ok) throw new Error(result.detail);
  return result.url;
}

function read(url: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function expectViewerPolicy(headers: import('node:http').IncomingHttpHeaders) {
  const policy = headers['content-security-policy'];
  for (const directive of ["default-src 'none'", "script-src 'self' 'unsafe-inline'", "connect-src 'self'", "base-uri 'self'", "form-action 'none'"]) {
    expect(policy).toContain(directive);
  }
  expect(policy).toContain(`frame-ancestors 'self' ${EMBEDDERS.join(' ')}`);
  expect(headers['x-dormouse-preserve-csp']).toBeUndefined();
  expect(headers['referrer-policy']).toBe('no-referrer');
}

it('preserves the real viewer policy and meta policy through HTML instrumentation', async () => {
  await writeFile(join(root, 'style.css'), 'body { color: red }');
  await writeFile(join(root, 'app.js'), 'window.loaded = true;');
  await writeFile(join(root, 'private.txt'), 'ungranted');
  const meta = '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'">';
  const url = await frame('index.html', `<html><head>${meta}<link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body>hello</body></html>`);
  const response = await read(url);
  expect(response.status).toBe(200);
  expectViewerPolicy(response.headers);
  expect(response.body).toContain(meta);
  expect(response.body).toContain('__dormouse');
  for (const name of ['style.css', 'app.js']) {
    const asset = await read(new URL(name, url).href);
    expect(asset.status).toBe(200);
    expectViewerPolicy(asset.headers);
  }
  expect((await read(new URL('private.txt', url).href)).status).toBe(404);
});

it('retains the policy for an escaped text preview', async () => {
  const response = await read(await frame('readme.md', '<script>untrusted()</script>'));
  expectViewerPolicy(response.headers);
  expect(response.body).toContain('&lt;script&gt;untrusted()&lt;/script&gt;');
  expect(response.body).toContain('__dormouse');
});

it.each([
  ['image.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
  ['document.pdf', '%PDF-1.7 example bytes', 'application/pdf'],
  ['image.png', 'image bytes', 'image/png'],
  ['video.mp4', 'video bytes', 'video/mp4'],
])('retains CSP, bytes, HEAD, and ranges for %s through the proxy', async (name, bytes, mime) => {
  const url = await frame(name, bytes);
  const response = await read(url);
  expectViewerPolicy(response.headers);
  expect(response.headers['content-type']).toBe(mime);
  expect(response.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
  expect(response.body).toBe(bytes);
  const head = await read(url, 'HEAD');
  expectViewerPolicy(head.headers);
  expect(head.headers['content-length']).toBe(response.headers['content-length']);
  expect(head.body).toBe('');
  const range = await read(url, 'GET', { Range: 'bytes=0-3' });
  expectViewerPolicy(range.headers);
  expect(range.status).toBe(206);
  expect(range.headers['content-range']).toBe(`bytes 0-3/${Buffer.byteLength(bytes)}`);
  expect(range.body).toBe(bytes.slice(0, 4));
});
