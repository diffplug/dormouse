import test from 'node:test';
import assert from 'node:assert/strict';
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

test('the gate itself refuses a non-JSON POST, so a bodyless route is covered too', () => {
  const post = (headers) => isAuthorized(
    { url: `/__dormouse_dev_host/send?t=${TOKEN}`, method: 'POST', headers: { host: `127.0.0.1:${PORT}`, ...headers } },
    { token: TOKEN, port: PORT },
  );
  assert.equal(post({ 'content-type': 'application/json' }), true);
  assert.equal(post({ 'content-type': 'text/plain' }), false);
  assert.equal(post({}), false);
  // GET carries no body, so it is exempt — that is how the SSE stream connects.
  assert.equal(isAuthorized(
    { url: `/__dormouse_dev_host/events?t=${TOKEN}`, method: 'GET', headers: { host: `127.0.0.1:${PORT}` } },
    { token: TOKEN, port: PORT },
  ), true);
});

test('CORS names one origin rather than *', () => {
  const headers = corsHeaders('http://localhost:1420');
  assert.equal(headers['access-control-allow-origin'], 'http://localhost:1420');
  assert.notEqual(headers['access-control-allow-origin'], '*');
  assert.equal(headers.vary, 'origin');
});
