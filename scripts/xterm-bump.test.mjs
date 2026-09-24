import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const CORE = '@xterm/xterm';
const FORK = '@diffplug/xterm-addon-webgl-sdf';
const ADDONS = ['fit', 'image', 'unicode-graphemes', 'webgl'].map((n) => `@xterm/addon-${n}`);
const oldCore = '6.1.0-beta.12';
const newCore = '7.1.0-beta.12';
const forkVersion = '0.20.0-sdf12.0';
const pins = { [CORE]: newCore, ...Object.fromEntries(ADDONS.map((n) => [n, '1.0.0-beta.2'])) };

function archive(manifest) {
  const data = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header[156] = 48;
  header.fill(32, 148, 156);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]));
}

function run(args, { manifest = {}, missingRelease = false, mismatchPeer = false, standalone = pins } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xterm-bump-'));
  try {
    for (const dir of ['scripts', 'lib', 'standalone', 'canopy']) mkdirSync(join(root, dir));
    copyFileSync(new URL('./xterm-bump.mjs', import.meta.url), join(root, 'scripts/xterm-bump.mjs'));
    for (const [dir, dependencies] of Object.entries({ lib: pins, standalone, canopy: { [CORE]: newCore, [FORK]: 'old-url', '@xterm/addon-webgl': '1.0.0-beta.2' } })) {
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ dependencies }, null, 2));
    }
    const versions = { [CORE]: { [oldCore]: { gitHead: 'old-commit' }, [newCore]: { gitHead: 'new-commit' } } };
    for (const addon of ADDONS) versions[addon] = {
      '1.0.0-beta.1': { gitHead: 'old-commit', peerDependencies: { [CORE]: `^${mismatchPeer ? newCore : oldCore}` } },
      '1.0.0-beta.2': { gitHead: 'new-commit', peerDependencies: { [CORE]: `^${newCore}` } },
    };
    writeFileSync(join(root, 'fixture.json'), JSON.stringify({ versions, missingRelease }));
    writeFileSync(join(root, 'release.tgz'), archive({ name: FORK, version: forkVersion, peerDependencies: { [CORE]: `^${oldCore}` }, ...manifest }));
    writeFileSync(join(root, 'fetch.mjs'), `
      import { readFileSync } from 'node:fs';
      const { versions, missingRelease } = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
      globalThis.fetch = async (url) => {
        if (url.startsWith('https://registry.npmjs.org/')) {
          const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
          if (!versions[name]) throw new Error('unexpected registry request: ' + url);
          return Response.json({ versions: versions[name] });
        }
        if (url.startsWith('https://github.com/diffplug/xterm.js/releases/download/')) {
          return new Response(missingRelease ? '' : readFileSync(new URL('./release.tgz', import.meta.url)), { status: missingRelease ? 404 : 200 });
        }
        throw new Error('unexpected network request: ' + url);
      };
    `);
    const result = spawnSync(process.execPath, ['--import', join(root, 'fetch.mjs'), join(root, 'scripts/xterm-bump.mjs'), ...args], { encoding: 'utf8' });
    const packages = Object.fromEntries(['lib', 'standalone', 'canopy'].map((dir) => [dir, JSON.parse(readFileSync(join(root, dir, 'package.json'))).dependencies]));
    return { ...result, packages };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const canopyArgs = ['--canopy', forkVersion];
test('canopy uses the released peer when the beta counter repeats on a newer release line', () => {
  const result = run(canopyArgs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.packages.canopy[CORE], oldCore);
  assert.equal(result.packages.canopy['@xterm/addon-webgl'], '1.0.0-beta.1');
  assert.match(result.packages.canopy[FORK], /sdf-v0\.20\.0-sdf12\.0/);
});
test('canopy dry-run verifies the release without rewriting pins', () => {
  const result = run([...canopyArgs, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.packages.canopy[FORK], 'old-url');
  assert.match(result.stdout, /canopy → fork .*@xterm\/xterm 6\.1\.0-beta\.12/);
});
for (const [label, options] of [
  ['missing release', { missingRelease: true }],
  ['wrong archive identity', { manifest: { name: '@xterm/addon-webgl' } }],
  ['wrong archive version', { manifest: { version: '0.20.0-sdf12.1' } }],
  ['missing core peer', { manifest: { peerDependencies: {} } }],
  ['peer counter mismatch', { manifest: { peerDependencies: { [CORE]: '^6.1.0-beta.13' } } }],
  ['upstream addon peer mismatch', { mismatchPeer: true }],
]) test(`canopy refuses ${label} before rewriting pins`, () => {
  const result = run(canopyArgs, options);
  assert.notEqual(result.status, 0);
  assert.equal(result.packages.canopy[FORK], 'old-url');
});
test('default bump repairs standalone when lib already has the newest coherent set', () => {
  const result = run([], { standalone: { ...pins, [CORE]: oldCore } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.packages.standalone, pins);
});
test('default dry-run preserves standalone drift', () => {
  const result = run(['--dry-run'], { standalone: { ...pins, [CORE]: oldCore } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.packages.standalone[CORE], oldCore);
  assert.match(result.stdout, /no files written/);
});

// --- xterm-lint check 4: the hand-copied UpstreamVsFork triple ---------------
//
// A self-test, not a second lint: the rule's whole job is to catch a hand-copy
// left behind by a rebase, and a finding check that never goes red is a claim
// rather than a control (AGENTS.md -> Specs). Each case mutates one field of
// the recorded triple and requires the lint to report it.

const lintCore = '6.1.0-beta.304';
const lintAddon = '0.20.0-beta.300';
const lintFork = '0.20.0-sdf304.0';
const lintCommit = 'c58ea363';
const forkUrl = (v) =>
  `https://github.com/diffplug/xterm.js/releases/download/sdf-v${v}/diffplug-xterm-addon-webgl-sdf-${v}.tgz`;

/** Run xterm-lint against a fixture root holding only canopy. */
function runLint({ addon = lintAddon, core = lintCore, commit = lintCommit, readmeCommit = lintCommit } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xterm-lint-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'canopy/src'), { recursive: true });
    copyFileSync(new URL('./xterm-lint.mjs', import.meta.url), join(root, 'scripts/xterm-lint.mjs'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - canopy\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), [
      'packages:',
      '',
      `  '@xterm/addon-webgl@${lintAddon}':`,
      '    peerDependencies:',
      `      '@xterm/xterm': ^${lintCore}`,
      '',
      `  '@diffplug/xterm-addon-webgl-sdf@${forkUrl(lintFork)}':`,
      '    peerDependencies:',
      `      '@xterm/xterm': ^${lintCore}`,
      '',
      'snapshots:',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'canopy/package.json'), JSON.stringify({
      dependencies: {
        [FORK]: forkUrl(lintFork),
        '@xterm/addon-webgl': lintAddon,
        [CORE]: lintCore,
      },
    }, null, 2));
    writeFileSync(
      join(root, 'canopy/src/GlTerminal.stories.tsx'),
      `// (addon ${addon} == core ${core} == commit ${commit}) — the regression baseline\n`,
    );
    writeFileSync(
      join(root, 'canopy/README.md'),
      `(addon \`${lintAddon}\` == core \`${lintCore}\` == commit \`${readmeCommit}\`)\n`,
    );
    return spawnSync(process.execPath, [join(root, 'scripts/xterm-lint.mjs')], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('xterm-lint accepts a canopy whose recorded triple matches its pins', () => {
  const result = runLint();
  assert.equal(result.status, 0, result.stderr);
});
for (const [label, mutation, expected] of [
  ['a stale upstream addon', { addon: '0.20.0-beta.299' }, /records upstream addon 0\.20\.0-beta\.299/],
  ['a stale core', { core: '6.1.0-beta.303' }, /records core 6\.1\.0-beta\.303/],
  ['two disagreeing commits', { commit: 'deadbee' }, /records fork-base commit/],
  ['a triple that is gone', { commit: 'not-a-sha' }, /no "addon <version> == core <version>/],
]) test(`xterm-lint rejects ${label} in the recorded triple`, () => {
  const result = runLint(mutation);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
});
