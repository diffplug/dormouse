/**
 * The URL checks every link grammar shares before it reads a fragment
 * (`remote-lib-common/src/security/link-url.ts`). The pairing grammar's own
 * rejections stay pinned end to end in `pairing-invitation.test.mjs`; this file
 * pins the helper at a shape other than pairing's, so a rule that quietly
 * assumed the root path would show here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LINK_LOOPBACK_HOSTS, isLinkScheme, parseLinkFragment } from '../dist/index.js';

const ORIGIN = 'https://app.example';
const SHAPE = { maxLength: 64, pathname: '/connect/', hashPrefix: '#' };

test('answers the fragment after the prefix, and checks nothing inside it', () => {
  assert.equal(parseLinkFragment(`${ORIGIN}/connect/#1.abc`, ORIGIN, SHAPE), '1.abc');
  assert.equal(parseLinkFragment(`${ORIGIN}/connect/#..~`, ORIGIN, SHAPE), '..~');
  // An empty fragment is no hash at all to `URL`, so there is no prefix to find.
  assert.equal(parseLinkFragment(`${ORIGIN}/connect/#`, ORIGIN, SHAPE), null);
  assert.equal(
    parseLinkFragment(`${ORIGIN}/#pair?x`, ORIGIN, { maxLength: 64, pathname: '/', hashPrefix: '#pair?' }),
    'x',
  );
});

test('measures the length before it parses anything', () => {
  const exact = `${ORIGIN}/connect/#${'a'.repeat(SHAPE.maxLength - `${ORIGIN}/connect/#`.length)}`;
  assert.equal(exact.length, SHAPE.maxLength);
  assert.ok(parseLinkFragment(exact, ORIGIN, SHAPE));
  assert.equal(parseLinkFragment(`${exact}a`, ORIGIN, SHAPE), null);
  assert.equal(parseLinkFragment('x'.repeat(1_000_000), ORIGIN, SHAPE), null);
  for (const value of [undefined, null, 42, {}, new URL(`${ORIGIN}/connect/#1`)]) {
    assert.equal(parseLinkFragment(value, ORIGIN, SHAPE), null);
  }
});

test('refuses a URL that is not this app, over HTTPS, at exactly its path', () => {
  for (const [why, text] of [
    ['not a URL at all', 'app.example/connect/#1'],
    ['plain http', 'http://app.example/connect/#1'],
    ['credentials in the authority', 'https://evil@app.example/connect/#1'],
    ['a password too', 'https://a:b@app.example/connect/#1'],
    ['the root path', `${ORIGIN}/#1`],
    ['no trailing slash', `${ORIGIN}/connect#1`],
    ['a deeper path', `${ORIGIN}/connect/x/#1`],
    ['a query string', `${ORIGIN}/connect/?next=x#1`],
    ['a different origin', 'https://app.evil/connect/#1'],
    ['a different port', 'https://app.example:8443/connect/#1'],
    ['no hash at all', `${ORIGIN}/connect/`],
    ['the wrong hash prefix', `${ORIGIN}/connect/#1`],
  ]) {
    const shape = why === 'the wrong hash prefix' ? { ...SHAPE, hashPrefix: '#pair?' } : SHAPE;
    assert.equal(parseLinkFragment(text, ORIGIN, shape), null, why);
  }
});

test('plain HTTP is accepted on exactly the three loopback hosts', () => {
  assert.deepEqual([...LINK_LOOPBACK_HOSTS].sort(), ['127.0.0.1', '[::1]', 'localhost']);
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    assert.equal(parseLinkFragment(`${origin}/connect/#1`, origin, SHAPE), '1', origin);
    assert.equal(isLinkScheme(new URL(origin)), true, origin);
  }
  // By host, never by suffix or range: each of these is an ordinary remote origin.
  for (const origin of ['http://evil.localhost', 'http://127.0.0.2', 'http://127.0.0.1.evil.example']) {
    assert.equal(parseLinkFragment(`${origin}/connect/#1`, origin, SHAPE), null, origin);
    assert.equal(isLinkScheme(new URL(origin)), false, origin);
  }
  assert.equal(isLinkScheme(new URL('https://app.example')), true);
  assert.equal(isLinkScheme(new URL('ftp://localhost')), false);
});
