/**
 * The environment → config mapping (docs/specs/server.md, "Configuration").
 * Pure, so no port is bound here; `bind-host.test.mjs` covers the actual listen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, readConfig } from '../dist/config.js';

const MINIMAL = { DORMOUSE_SETUP_PASSWORD: 'correct horse battery staple' };

test('defaults: port 3000, every interface, localhost origin', () => {
  const config = readConfig({ ...MINIMAL });
  assert.equal(config.port, 3000);
  assert.equal(config.bindHost, undefined);
  assert.equal(config.origin, 'http://localhost:3000');
  assert.equal(config.stateDir, './data');
});

test('DORMOUSE_BIND_HOST pins the listen interface', () => {
  const config = readConfig({ ...MINIMAL, DORMOUSE_BIND_HOST: '127.0.0.1' });
  assert.equal(config.bindHost, '127.0.0.1');
});

test('a blank DORMOUSE_BIND_HOST is treated as unset, not as an empty host', () => {
  assert.equal(readConfig({ ...MINIMAL, DORMOUSE_BIND_HOST: '' }).bindHost, undefined);
  assert.equal(readConfig({ ...MINIMAL, DORMOUSE_BIND_HOST: '   ' }).bindHost, undefined);
});

test('the default origin follows PORT', () => {
  assert.equal(readConfig({ ...MINIMAL, PORT: '3100' }).origin, 'http://localhost:3100');
});

test('DORMOUSE_ORIGIN wins over the port-derived default', () => {
  const config = readConfig({ ...MINIMAL, PORT: '3100', DORMOUSE_ORIGIN: 'https://dor.example.ts.net' });
  assert.equal(config.origin, 'https://dor.example.ts.net');
});

test('a missing setup password is a ConfigError, not a silent start', () => {
  assert.throws(() => readConfig({}), ConfigError);
});

test('an unusable PORT is a ConfigError', () => {
  assert.throws(() => readConfig({ ...MINIMAL, PORT: 'https' }), ConfigError);
  assert.throws(() => readConfig({ ...MINIMAL, PORT: '70000' }), ConfigError);
});

test('state and pocket dirs are overridable, with a cwd-independent pocket default', () => {
  const config = readConfig({ ...MINIMAL, DORMOUSE_STATE_DIR: '/var/lib/dormouse' });
  assert.equal(config.stateDir, '/var/lib/dormouse');
  assert.match(config.pocketDir, /lib[/\\]dist-pocket$/);
  assert.equal(readConfig({ ...MINIMAL, DORMOUSE_POCKET_DIR: '/app/pocket' }).pocketDir, '/app/pocket');
});
