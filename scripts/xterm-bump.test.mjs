import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const CORE = '@xterm/xterm';
const ADDONS = ['fit', 'image', 'serialize', 'unicode-graphemes', 'webgl'].map((n) => `@xterm/addon-${n}`);
const oldCore = '6.1.0-beta.12';
const newCore = '7.1.0-beta.12';
const pins = { [CORE]: newCore, ...Object.fromEntries(ADDONS.map((n) => [n, '1.0.0-beta.2'])) };
// standalone pins, as devDependencies, only the subset its tests mock.
const { '@xterm/addon-webgl': _webgl, ...standalonePins } = pins;

function run(args, { lib = pins, standalone = standalonePins } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xterm-bump-'));
  try {
    for (const dir of ['scripts', 'lib', 'standalone']) mkdirSync(join(root, dir));
    copyFileSync(new URL('./xterm-bump.mjs', import.meta.url), join(root, 'scripts/xterm-bump.mjs'));
    for (const [dir, dependencies] of Object.entries({ lib, standalone })) {
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(dir === 'standalone' ? { devDependencies: dependencies } : { dependencies }, null, 2));
    }
    const versions = { [CORE]: { [oldCore]: { gitHead: 'old-commit' }, [newCore]: { gitHead: 'new-commit' } } };
    for (const addon of ADDONS) versions[addon] = {
      '1.0.0-beta.1': { gitHead: 'old-commit', peerDependencies: { [CORE]: `^${oldCore}` } },
      '1.0.0-beta.2': { gitHead: 'new-commit', peerDependencies: { [CORE]: `^${newCore}` } },
    };
    writeFileSync(join(root, 'fixture.json'), JSON.stringify({ versions }));
    writeFileSync(join(root, 'fetch.mjs'), `
      import { readFileSync } from 'node:fs';
      const { versions } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
      globalThis.fetch = async (url) => {
        if (url.startsWith('https://registry.npmjs.org/')) {
          const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
          if (!versions[name]) throw new Error('unexpected registry request: ' + url);
          return Response.json({ versions: versions[name] });
        }
        throw new Error('unexpected network request: ' + url);
      };
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'fetch.mjs')).href, join(root, 'scripts/xterm-bump.mjs'), ...args], { encoding: 'utf8' });
    const packages = Object.fromEntries(['lib', 'standalone'].map((dir) => [dir, JSON.parse(readFileSync(join(root, dir, 'package.json')))[dir === 'standalone' ? 'devDependencies' : 'dependencies']]));
    return { ...result, packages };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('default bump repairs standalone when lib already has the newest coherent set', () => {
  const result = run([], { standalone: { ...standalonePins, [CORE]: oldCore } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.packages.standalone, standalonePins);
});
test('default bump repins every addon lib depends on', () => {
  const stale = { ...pins, '@xterm/addon-serialize': '1.0.0-beta.1' };
  const { '@xterm/addon-webgl': _staleWebgl, ...standaloneStale } = stale;
  const result = run([], { lib: stale, standalone: standaloneStale });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.packages.lib, pins);
  assert.deepEqual(result.packages.standalone, standalonePins);
});
test('default dry-run preserves standalone drift', () => {
  const result = run(['--dry-run'], { standalone: { ...standalonePins, [CORE]: oldCore } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.packages.standalone[CORE], oldCore);
  assert.match(result.stdout, /no files written/);
});
