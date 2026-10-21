import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertHostedBundlesDisclosed, bundledReleases, hostedBundleEntries, hostedBundles, moduleScriptEntries, undisclosedReleases } from './hosted-bundles.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const committed = () => JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/data/dependencies-npm.json'), 'utf-8'));

describe('Hosted bundle disclosure', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('flags a bundled release no section lists, by name or by version', () => {
    const disclosure = { terminal: [{ name: 'a', versions: ['1.0.0'] }], hosted: [{ name: '@s/b', versions: ['2.0.0', '2.1.0'] }] };
    const releases = [
      { name: 'a', version: '1.0.0' },
      { name: '@s/b', version: '2.1.0' },
      { name: 'a', version: '1.0.1' },
      { name: 'c', version: '3.0.0' },
      { name: 'c', version: '3.0.0' },
    ];
    expect(undisclosedReleases(releases, disclosure)).toEqual(['a@1.0.1', 'c@3.0.0']);
  });

  it('reads each bundled package\'s release from its root, scoped or not, and skips workspace sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-bundles-'));
    dirs.push(dir);
    const pkg = (path, name, version) => {
      mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ name, version }));
    };
    pkg('node_modules/.pnpm/x@1.0.0/node_modules/x', 'x', '1.0.0');
    pkg('node_modules/.pnpm/@s+y@2.0.0/node_modules/@s/y', '@s/y', '2.0.0');
    const metafile = {
      inputs: {
        'node_modules/.pnpm/x@1.0.0/node_modules/x/lib/index.js': {},
        'node_modules/.pnpm/x@1.0.0/node_modules/x/lib/deep/package.json': {},
        'node_modules/.pnpm/@s+y@2.0.0/node_modules/@s/y/dist/esm/y.js': {},
        '../remote-lib-common/src/index.ts': {},
        'server/worker.ts': {},
      },
    };
    expect(bundledReleases(metafile, dir)).toEqual([{ name: 'x', version: '1.0.0' }, { name: '@s/y', version: '2.0.0' }]);
  });

  it('bundles every Worker the deploy configures and the account page', () => {
    expect(hostedBundleEntries(repoRoot)).toEqual([
      { entry: 'server/worker.ts', platform: 'worker' },
      { entry: 'server/relay-worker.ts', platform: 'worker' },
      { entry: 'server/voice-worker.ts', platform: 'worker' },
      { entry: 'src/main.tsx', platform: 'browser' },
    ]);
  });

  it('reads a module script\'s src in any attribute order, and refuses one it cannot read', () => {
    expect(moduleScriptEntries([
      '<script type="module" src="/src/main.tsx"></script>',
      '<script src="/src/extra.ts" type="module"></script>',
      '<script src="/classic.js"></script>',
    ].join('\n'))).toEqual(['src/main.tsx', 'src/extra.ts']);
    expect(() => moduleScriptEntries("<script type='module' src='/src/main.tsx'></script>")).toThrow(/cannot read the src/);
  });

  it('finds every release Hosted bundles in the committed disclosure, and fails on one it drops', async () => {
    const bundles = await hostedBundles(repoRoot);
    const names = (entry) => bundles.find((b) => b.entry === entry).releases.map((r) => r.name);
    // A real bundle, not an empty one: the database driver in every Worker, React in the page.
    for (const entry of ['server/worker.ts', 'server/relay-worker.ts', 'server/voice-worker.ts']) expect(names(entry)).toContain('pg');
    expect(names('src/main.tsx')).toContain('react-dom');
    await expect(assertHostedBundlesDisclosed(committed(), repoRoot)).resolves.toBeUndefined();
    // `pg` reaches the walk only through `pgstencil`; were that edge gone, the bundle would still hold it.
    const withoutPg = Object.fromEntries(Object.entries(committed()).map(([id, rows]) => [id, rows.filter((row) => row.name !== 'pg')]));
    await expect(assertHostedBundlesDisclosed(withoutPg, repoRoot)).rejects.toThrow(/pg@[\d.]+ \(bundled from hosted\/server\/worker\.ts\)/);
  }, 30_000);
});
