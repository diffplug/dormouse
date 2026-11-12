// Runs VSCE, node-pg-migrate, archiver-utils, and Testcontainers through the
// glob and minimatch `overrides` in pnpm-workspace.yaml, without Docker or
// Postgres.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const hosted = createRequire(new URL('../hosted/package.json', import.meta.url));
const extension = createRequire(new URL('../vscode-ext/package.json', import.meta.url));
const containers = createRequire(hosted.resolve('testcontainers'));
const archiver = createRequire(containers.resolve('archiver'));

async function fixture(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dormouse-dependency-overrides-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

// These run the consumers, not just glob/minimatch in isolation: the overrides
// cross their declared major ranges. Fixtures need neither Docker nor Postgres.
test('VSCE preserves ignore patterns, negations, and dotfiles when listing package contents', async t => {
  const dir = await fixture(t, {
    'package.json': JSON.stringify({ name: 'override-fixture', version: '1.0.0', publisher: 'test', engines: { vscode: '^1.92.0' } }),
    '.vscodeignore': 'src/**\nassets/**\n!assets/keep.txt\n**/*.map\n',
    'src/private.ts': 'private', 'assets/keep.txt': 'keep', 'assets/drop.txt': 'drop',
    'dist/extension.js': 'module.exports = {}', 'dist/extension.js.map': '{}', '.included': 'dotfile',
  });
  const { listFiles, PackageManager } = extension('@vscode/vsce');
  const files = await listFiles({ cwd: dir, packageManager: PackageManager.None });
  assert.deepEqual(files.map(f => f.replaceAll('\\', '/')).sort(),
    ['.included', 'assets/keep.txt', 'dist/extension.js', 'package.json']);
});

test('node-pg-migrate discovers nested migrations in order and excludes ignored paths', async t => {
  const dir = await fixture(t, {
    'nested/002-second.sql': 'SELECT 2;', '001-first.sql': 'SELECT 1;',
    'ignored/003-private.sql': 'SELECT 3;', 'notes.txt': 'not a migration',
  });
  const { getMigrationFilePaths } = await import(pathToFileURL(hosted.resolve('node-pg-migrate/migration')).href);
  const files = await getMigrationFilePaths(path.join(dir, '**/*.sql').replaceAll('\\', '/'), {
    useGlob: true, ignorePattern: '**/ignored/**',
  });
  assert.deepEqual(files, [path.join(dir, '001-first.sql'), path.join(dir, 'nested/002-second.sql')]);
});

test('archiver-utils expands file patterns with exclusions and dotfiles', async t => {
  const dir = await fixture(t, { 'nested/a.txt': 'a', 'nested/b.txt': 'b', '.hidden.txt': 'hidden', 'skip.txt': 'skip' });
  const { file } = archiver('archiver-utils');
  assert.deepEqual(file.expand({ cwd: dir, dot: true, nodir: true }, ['**/*.txt', '!skip.txt']).sort(),
    ['.hidden.txt', 'nested/a.txt', 'nested/b.txt']);
});

test('Testcontainers still builds readable copy archives with files, directories, and inline content', async t => {
  const dir = await fixture(t, { 'single.txt': 'single', 'nested/a.txt': 'nested' });
  const { GenericContainer } = hosted('testcontainers');
  const container = new GenericContainer('unused-test-image')
    .withCopyFilesToContainer([{ source: path.join(dir, 'single.txt'), target: '/single.txt' }])
    .withCopyDirectoriesToContainer([{ source: path.join(dir, 'nested'), target: '/nested' }])
    .withCopyContentToContainer([{ content: 'inline', target: '/inline.txt' }]);
  const tar = await container.createArchiveToCopyToContainer();
  const extract = archiver('tar-stream').extract();
  const files = {};
  const read = (async () => {
    for await (const entry of extract) {
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      if (entry.header.type === 'file') files[entry.header.name.replace(/^\//, '')] = Buffer.concat(chunks).toString();
    }
  })();
  tar.pipe(extract);
  await Promise.all([tar.finalize(), read]);
  assert.deepEqual(files, { 'single.txt': 'single', 'nested/a.txt': 'nested', 'inline.txt': 'inline' });
});
