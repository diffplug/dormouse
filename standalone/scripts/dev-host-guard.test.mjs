import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { corsHeaders, isAuthorized, isJsonRequest } from './dev-host-guard.mjs';

const TOKEN = 'a'.repeat(48);
const PORT = 1422;
const req = (url, headers) => ({ url, headers });
const ok = (url, host = `127.0.0.1:${PORT}`) => isAuthorized(req(url, { host }), { token: TOKEN, port: PORT });

test('a request carrying the token is authorized', () => {
  assert.equal(ok(`/__dormouse_dev_host/send?t=${TOKEN}`), true);
  assert.equal(ok(`/__dormouse_dev_host/events?t=${TOKEN}`, `localhost:${PORT}`), true);
});

test('a request with no token, a wrong token, or a wrong-length token is refused', () => {
  // The wrong-length case is the one that would throw rather than return false
  // if the digests were not equalized before timingSafeEqual.
  assert.equal(ok('/__dormouse_dev_host/send'), false);
  assert.equal(ok('/__dormouse_dev_host/send?t='), false);
  assert.equal(ok(`/__dormouse_dev_host/send?t=${'b'.repeat(48)}`), false);
  assert.equal(ok('/__dormouse_dev_host/send?t=short'), false);
  assert.equal(ok(`/__dormouse_dev_host/send?t=${TOKEN}x`), false);
});

test('a rebound hostile domain is refused even holding the token', () => {
  // DNS rebinding: evil.com re-resolved to 127.0.0.1 reaches this port with its
  // own name in Host, and the browser calls that same-origin.
  assert.equal(ok(`/__dormouse_dev_host/send?t=${TOKEN}`, 'evil.com:1422'), false);
  assert.equal(ok(`/__dormouse_dev_host/send?t=${TOKEN}`, `127.0.0.1:${PORT + 1}`), false);
  assert.equal(isAuthorized(req(`/?t=${TOKEN}`, {}), { token: TOKEN, port: PORT }), false);
});

test('only application/json bodies are accepted', () => {
  // text/plain is the CORS-simple content type a no-cors attack would use.
  assert.equal(isJsonRequest(req('/', { 'content-type': 'application/json' })), true);
  assert.equal(isJsonRequest(req('/', { 'content-type': 'application/json; charset=utf-8' })), true);
  assert.equal(isJsonRequest(req('/', { 'content-type': 'text/plain' })), false);
  assert.equal(isJsonRequest(req('/', { 'content-type': 'multipart/form-data' })), false);
  assert.equal(isJsonRequest(req('/', {})), false);
});

test('CORS names one origin rather than *', () => {
  const headers = corsHeaders('http://localhost:1420');
  assert.equal(headers['access-control-allow-origin'], 'http://localhost:1420');
  assert.notEqual(headers['access-control-allow-origin'], '*');
  assert.equal(headers.vary, 'origin');
});

test('end to end, an unauthorized caller cannot tell the port from a closed one', async () => {
  // Guards the ordering in dev-agent-browser.mjs: the gate runs before routing
  // and before any body read, so every refusal looks like the fall-through 404.
  let dispatched = false;
  const server = http.createServer((request, response) => {
    if (!isAuthorized(request, { token: TOKEN, port: server.address().port })) {
      response.writeHead(404).end('not found');
      return;
    }
    dispatched = true;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = (query) => `http://127.0.0.1:${port}/__dormouse_dev_host/send${query}`;

  const attack = await fetch(url(''), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"cmd":"pty_spawn","args":{"options":{"shell":"/bin/sh","args":["-c","touch /tmp/pwned"]}}}',
  });
  assert.equal(attack.status, 404);
  assert.equal(await attack.text(), 'not found');
  assert.equal(dispatched, false, 'pty_spawn must not reach the sidecar');

  const legit = await fetch(url(`?t=${TOKEN}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"cmd":"pty_request_init"}',
  });
  assert.equal(legit.status, 200);
  assert.equal(dispatched, true);
  await new Promise((resolve) => server.close(resolve));
});
