/**
 * The one reduction of a URL to a bare scheme-host-port, shared by the Relay's
 * `DORMOUSE_ORIGIN`, the `origin` a Host reads off an enrollment response, and
 * the installer offer file's own field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOrigin, normalizeOrigin } from '../dist/index.js';

test('normalizeOrigin reduces a URL to scheme, host and port', () => {
  assert.equal(normalizeOrigin('https://dor.example.ts.net/'), 'https://dor.example.ts.net');
  assert.equal(
    normalizeOrigin('https://dor.example.ts.net:8443/pocket?x=1#y'),
    'https://dor.example.ts.net:8443',
  );
  // The host lowercases and a default port drops — the bare form a browser
  // sends as `clientData.origin`.
  assert.equal(normalizeOrigin('https://Dor.Example.TS.NET:443'), 'https://dor.example.ts.net');
});

test('normalizeOrigin answers null for anything without a host', () => {
  // `URL.origin` is the *string* `'null'` for a scheme that has none, which
  // every compare downstream would otherwise run against.
  for (const value of ['mailto:ned@example.com', 'file:///tmp/x', 'dor.example.ts.net', '', null, undefined, 0, {}]) {
    assert.equal(normalizeOrigin(value), null, String(value));
  }
});

test('isOrigin accepts only a string that is already bare', () => {
  assert.equal(isOrigin('https://dor.example.ts.net'), true);
  assert.equal(isOrigin('http://localhost:3000'), true);
  for (const value of ['https://dor.example.ts.net/', 'https://dor.example.ts.net/x', 'nope']) {
    assert.equal(isOrigin(value), false, String(value));
  }
});

test('isOrigin rejects non-strings, which normalizeOrigin would compare equal to themselves', () => {
  // Without the `typeof` guard `isOrigin(null)` is true — both sides are
  // `null` — and the next caller reading raw JSON accepts `"origin": null`.
  for (const value of [null, undefined, 0, {}, [], false]) {
    assert.equal(isOrigin(value), false, String(value));
  }
});
