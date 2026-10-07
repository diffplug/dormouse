import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The updater's trust root: the one minisign key every shipped app accepts an
 * update from, and the one manifest it asks. A change to either reaches every
 * install on its next update, so it is pinned here byte for byte rather than
 * left to review (docs/specs/security-ci.md -> "Desktop Releases").
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, '..', 'src-tauri');
const repo = join(here, '..', '..');
const conf = JSON.parse(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8'));

/** The production updater key's minisign id, as `minisign -G` printed it. */
const KEY_ID = 'AC5A7E8D541A64DB';
const PUBKEY = [
  `untrusted comment: minisign public key: ${KEY_ID}`,
  'RWTbZBpUjX5arLQB0Ell8jxI1Fy/eDSJF59nKXOGAu8g5OpTa5clwtXm',
  '',
].join('\n');
const ENDPOINT = 'https://dormouse.sh/standalone-latest.json';

/** The 8-byte key id inside a minisign key or signature line, as minisign prints it. */
function keyIdOf(line) {
  const bytes = Buffer.from(line, 'base64');
  return Buffer.from(bytes.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

test('the updater trusts exactly the production key', () => {
  const pubkey = Buffer.from(conf.plugins.updater.pubkey, 'base64').toString('utf8');
  assert.equal(pubkey, PUBKEY);
  assert.equal(keyIdOf(pubkey.split('\n')[1]), KEY_ID, 'the key line carries the id its comment names');
});

test('the updater asks exactly one https endpoint, on dormouse.sh', () => {
  assert.deepEqual(conf.plugins.updater.endpoints, [ENDPOINT]);
  // The one switch that would let the updater accept a plain-http endpoint.
  assert.equal(conf.plugins.updater.dangerousInsecureTransportProtocol, undefined);
});

// Tauri merges `tauri.<platform>.conf.json` over this file at build time, so a
// platform overlay could swap the key for one platform without touching it.
test('no platform overlay can replace the updater configuration', () => {
  const overlays = readdirSync(srcTauri).filter((name) =>
    /^tauri\..+\.conf\.json5?$/.test(name) || /^Tauri(\..+)?\.toml$/.test(name));
  for (const name of overlays) {
    const text = readFileSync(join(srcTauri, name), 'utf8');
    assert.ok(!/updater/.test(text), `${name} configures the updater`);
  }
});

// The manifest the endpoint serves is committed (docs/specs/deploy.md -> "Update
// manifest"); a release signed by any other key would install nowhere.
test('every published update is signed by the trusted key', () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'website', 'public', 'standalone-latest.json'), 'utf8'));
  const platforms = Object.entries(manifest.platforms);
  assert.ok(platforms.length > 0);
  for (const [platform, { signature, url }] of platforms) {
    const lines = Buffer.from(signature, 'base64').toString('utf8').split('\n');
    assert.equal(keyIdOf(lines[1]), KEY_ID, `${platform}'s signature names another key`);
    assert.match(url, /^https:\/\/github\.com\/diffplug\/dormouse\/releases\/download\//, platform);
  }
});
