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

test('a blank PORT is treated as unset, not as port 0', () => {
  // `Number('')` is 0, which asks the OS for an ephemeral port — so a `PORT=`
  // left empty in a `.env` would move the server off 3000 and out from under
  // whatever proxy is pointed at it.
  assert.equal(readConfig({ ...MINIMAL, PORT: '' }).port, 3000);
  assert.equal(readConfig({ ...MINIMAL, PORT: '   ' }).port, 3000);
});

test('an explicit PORT=0 is refused rather than randomized', () => {
  // Nothing can be pointed at a port that changes on every restart.
  assert.throws(() => readConfig({ ...MINIMAL, PORT: '0' }), ConfigError);
});

test('state and pocket dirs are overridable, with a cwd-independent pocket default', () => {
  const config = readConfig({ ...MINIMAL, DORMOUSE_STATE_DIR: '/var/lib/dormouse' });
  assert.equal(config.stateDir, '/var/lib/dormouse');
  assert.match(config.pocketDir, /lib[/\\]dist-pocket$/);
  assert.equal(readConfig({ ...MINIMAL, DORMOUSE_POCKET_DIR: '/app/pocket' }).pocketDir, '/app/pocket');
});

test('no VAPID keys in the environment leaves them for the entrypoint to mint', () => {
  assert.equal(readConfig({ ...MINIMAL }).vapidKeys, null);
});

test('a VAPID keypair is taken from the environment as a pair', () => {
  const config = readConfig({
    ...MINIMAL,
    DORMOUSE_VAPID_PUBLIC_KEY: 'pub',
    DORMOUSE_VAPID_PRIVATE_KEY: 'priv',
  });
  assert.deepEqual(config.vapidKeys, { publicKey: 'pub', privateKey: 'priv' });
});

test('half a VAPID keypair is a ConfigError, not a guessed default', () => {
  // A mismatched pair stops every subscription working, silently.
  assert.throws(() => readConfig({ ...MINIMAL, DORMOUSE_VAPID_PUBLIC_KEY: 'pub' }), ConfigError);
  assert.throws(() => readConfig({ ...MINIMAL, DORMOUSE_VAPID_PRIVATE_KEY: 'priv' }), ConfigError);
});

test('DORMOUSE_VAPID_SUBJECT wins over the origin-derived default', () => {
  const config = readConfig({
    ...MINIMAL,
    DORMOUSE_ORIGIN: 'https://dor.example.ts.net',
    DORMOUSE_VAPID_SUBJECT: 'mailto:admin@example.com',
  });
  assert.equal(config.vapidSubject, 'mailto:admin@example.com');
});

test('the enroll token file is an absolute installer path, or nothing', () => {
  // Unset means one-click enrollment is simply off — the case for dev, for
  // containers, and for every test that does not opt in.
  assert.equal(readConfig({ ...MINIMAL }).enrollTokenFile, null);
  assert.equal(readConfig({ ...MINIMAL, DORMOUSE_ENROLL_TOKEN_FILE: '   ' }).enrollTokenFile, null);
  assert.equal(
    readConfig({ ...MINIMAL, DORMOUSE_ENROLL_TOKEN_FILE: '/var/lib/dormouse/enroll.json' })
      .enrollTokenFile,
    '/var/lib/dormouse/enroll.json',
  );
  assert.throws(
    () => readConfig({ ...MINIMAL, DORMOUSE_ENROLL_TOKEN_FILE: 'run/enroll.json' }),
    /must be an absolute path/,
  );
});

test('the VAPID subject falls back to a routable origin, and to nothing on loopback', () => {
  assert.equal(
    readConfig({ ...MINIMAL, DORMOUSE_ORIGIN: 'https://dor.example.ts.net' }).vapidSubject,
    'https://dor.example.ts.net',
  );
  // A loopback dev server: push is off rather than half-working, since Apple
  // rejects such a JWT and every delivery would fail silently.
  assert.equal(readConfig({ ...MINIMAL }).vapidSubject, null);
});
