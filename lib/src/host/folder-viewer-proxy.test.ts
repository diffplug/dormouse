import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startFolderViewer } from '../../../dor/src/folder-viewer';
import { createIframeProxyUrl } from './iframe-proxy';

// The folder viewer's page is framed through the iframe proxy, so its POSTs
// reach the viewer with whatever Origin the proxy forwards.
const EMBEDDERS = ['vscode-webview://viewer-test'];
let root: string;
const opened: { path: string; preview: boolean }[] = [];
const viewers: Awaited<ReturnType<typeof startFolderViewer>>[] = [];
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dor-folder-proxy-'))); });
afterEach(async () => {
  opened.length = 0;
  await Promise.all(viewers.splice(0).map(viewer => viewer.close()));
  await rm(root, { recursive: true, force: true });
});

async function frame() {
  const viewer = await startFolderViewer(root, { open: async (path, preview) => { opened.push({ path, preview }); return { ok: true, status: 'created' }; } });
  viewers.push(viewer);
  const result = await createIframeProxyUrl(`http://127.0.0.1:${viewer.port}${viewer.path}`, { embedderOrigins: EMBEDDERS });
  if (!result.ok) throw new Error(result.detail);
  return result.url;
}

function send(url: string, method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

it('keeps its policy through the proxy and accepts a POST only from the framed page', async () => {
  await writeFile(join(root, 'a.txt'), 'a');
  const url = await frame();
  const page = await send(url);
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  expect(page.headers['content-security-policy']).toContain(`frame-ancestors 'self' ${EMBEDDERS.join(' ')}`);
  expect(page.body).toContain('__dormouse');
  expect(JSON.parse((await send(new URL('list', url).href)).body).entries).toEqual([{ name: 'a.txt', kind: 'file', ignored: false }]);

  const select = (origin?: string) => send(new URL('select', url).href, 'POST',
    { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, JSON.stringify({ path: 'a.txt' }));
  // The page's same-origin POST carries the proxy's origin, which the proxy vouches for upstream.
  const own = await select(new URL(url).origin);
  expect(own.status).toBe(200);
  expect(JSON.parse(own.body)).toEqual({ ok: true, status: 'created' });
  // A foreign or absent Origin is forwarded as it came, and the viewer refuses it.
  expect((await select('https://evil.test')).status).toBe(403);
  expect((await select()).status).toBe(403);
  expect(opened).toEqual([{ path: join(root, 'a.txt'), preview: true }]);
});
