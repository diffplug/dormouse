import assert from 'node:assert/strict';
import { request } from 'node:http';
import { afterEach, test } from 'node:test';
import { startErrorViewer } from '../dist/error-viewer.js';

const viewers = [];
afterEach(async () => { await Promise.all(viewers.splice(0).map(v => v.close())); });
async function start(target, message) {
  const viewer = await startErrorViewer(target, message);
  viewers.push(viewer);
  return viewer;
}
function get(viewer, path = viewer.path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: viewer.port, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves only its escaped message page, script-free, under the capability', async () => {
  const viewer = await start('/repo/<b>.pdf', `no Tool matches '/repo/<b>.pdf'; add an open rule`);
  const page = await get(viewer);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /script-src/);
  assert.match(page.body, /<h1>Can't show &lt;b&gt;\.pdf<\/h1>/);
  assert.match(page.body, /no Tool matches &#39;\/repo\/&lt;b&gt;\.pdf&#39;; add an open rule/);
  assert.doesNotMatch(page.body, /<script|<b>/);
  assert.equal((await get(viewer, `${viewer.path}x`)).status, 404);
  assert.equal((await get(viewer, '/')).status, 403);
  assert.equal((await get(viewer, viewer.path, { Origin: 'https://elsewhere.test' })).status, 403);
});
