import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createToolHost } from './tool-host';

let root: string;
let config: string;
const writeConfig = (yaml: string) => writeFile(config, yaml);
const viewerConfig = (match: string) => `tools:\n  viewer:\n    run: [view, $TARGET]\nopen:\n  - {match: '${match}', tool: viewer}\n`;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dor-open-')));
  config = join(root, 'user.yml');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'README.md'), 'hi');
  await writeConfig(`tools:
  special:
    run: [special, $TARGET]
    prespawn_dedupe: [$TARGET]
  markdown:
    run: [markdown, $TARGET]
open:
  - match: docs/README.md
    tool: special
  - match: '**/*.md'
    tool: markdown
`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const host = () => createToolHost({ userConfigPath: config });

it('uses the first user rule and never discovers project definitions', async () => {
  await writeFile(join(root, 'dormouse.yml'), 'this is not even valid Tool configuration');
  const target = join(root, 'docs', 'README.md');
  expect(await host().handle({ op: 'open', target: 'docs/README.md', cwd: root })).toMatchObject({
    status: 'ok', scope: 'user', name: 'special', run: ['special', target], key: [target],
  });
  expect(await host().handle({ op: 'open', target, cwd: root, tool: 'markdown' })).toMatchObject({
    status: 'ok', scope: 'user', name: 'markdown', run: ['markdown', target],
  });
});

it('matches slashless patterns against the filename', async () => {
  await writeConfig(viewerConfig('*.md'));
  const target = join(root, 'docs', 'a b; $(touch nope).md');
  await writeFile(target, 'hi');
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'ok', run: ['view', target] });
});

it.skipIf(process.platform === 'win32')('keys symlink aliases on the same canonical file', async () => {
  const target = join(root, 'docs', 'README.md');
  await symlink(target, join(root, 'alias.md'));
  const first = await host().handle({ op: 'open', target, cwd: root });
  const second = await host().handle({ op: 'open', target: 'alias.md', cwd: root });
  expect(second).toEqual(first);
});

it.each(['https://example.com/file.md', 'file:///etc/passwd', 'surface:3', 'docs', 'missing.md'])('rejects %s as a local regular-file target', async target => {
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'error' });
});

it('names the user configuration in unmatched-file errors', async () => {
  const target = join(root, 'unknown.binary');
  await writeFile(target, 'hi');
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'error', message: expect.stringContaining(config) });
});

it.each(['explicit', 'association'] as const)('explains unsupported formats when builtin:file is selected by %s', async selection => {
  const target = join(root, 'unknown.binary');
  await writeFile(target, 'hi');
  if (selection === 'association') await writeConfig('open:\n  - {match: "*.binary", tool: "builtin:file"}\n');
  else await rm(config);
  expect(await host().handle({ op: 'open', target, cwd: root, ...(selection === 'explicit' ? { tool: 'builtin:file' } : {}) })).toEqual({
    status: 'error', message: `the built-in viewer does not support 'unknown.binary'; add an open rule to ${config} naming a user Tool`,
  });
});

it('uses the built-in viewer only as a fallback or explicit choice', async () => {
  const target = join(root, 'docs', 'README.md');
  expect(await host().handle({ op: 'open', target, cwd: root, tool: 'builtin:file' })).toMatchObject({
    status: 'ok', scope: 'builtin', run: ['dor', '__view-file', target], key: [target], port: 'announced',
  });
  await writeFile(config, 'open:\n  - {match: "*.md", tool: "builtin:file"}\n');
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'ok', scope: 'builtin' });
  await rm(config);
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'ok', scope: 'builtin' });
  expect(await host().handle({ op: 'open', target, cwd: root, tool: 'missing' })).toMatchObject({ status: 'error' });
});

it('matches catch-all rules above the invocation directory and canonical absolute rules', async () => {
  await mkdir(join(root, 'work'));
  await writeConfig(viewerConfig('**/*.md'));
  const request = { op: 'open', target: '../docs/README.md', cwd: join(root, 'work') } as const;
  expect(await host().handle(request)).toMatchObject({ status: 'ok', name: 'viewer' });
  await writeConfig(viewerConfig(join(root, 'docs').replace(/\\/g, '/') + '/**'));
  expect(await host().handle(request)).toMatchObject({ status: 'ok', name: 'viewer' });
});

it('requires a user Tool for PDFs', async () => {
  const target = join(root, 'README.pdf');
  await writeFile(target, '%PDF-1.7');
  await rm(config);
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'error', message: expect.stringContaining('add an open rule') });
  expect(await host().handle({ op: 'open', target, cwd: root, tool: 'builtin:file' })).toMatchObject({ status: 'error', message: expect.stringContaining('does not support') });
  await writeConfig(viewerConfig('*.pdf'));
  expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ status: 'ok', scope: 'user', run: ['view', target] });
});

it('matches the first specific rule through a symlinked working directory without changing the run directory', async () => {
  await writeConfig(`tools:
  special:
    run: [special, $TARGET, $CWD]
    prespawn_dedupe: [$TARGET]
  markdown:
    run: [markdown, $TARGET]
open:
  - {match: docs/README.md, tool: special}
  - {match: '**/*.md', tool: markdown}
`);
  const cwd = join(root, 'alias');
  await symlink(root, cwd, 'junction');
  const target = join(root, 'docs', 'README.md');
  expect(await host().handle({ op: 'open', target: 'docs/README.md', cwd })).toMatchObject({
    status: 'ok', name: 'special', run: ['special', target, cwd], key: [target],
  });
});

it('still matches an absolute target when the working directory no longer exists', async () => {
  const target = join(root, 'docs', 'README.md');
  const cwd = join(root, 'missing');
  expect(await host().handle({ op: 'open', target, cwd })).toMatchObject({
    status: 'ok', name: 'markdown', run: ['markdown', target],
  });
});

it('reports the user file warnings on the built-in viewer path too', async () => {
  // Nothing in the user file runs for a built-in open, but the file was still
  // parsed to decide that — its lint belongs to the user either way
  // (`docs/specs/dor-tool.md` -> Opening local files).
  await writeConfig(`tools:
  viewer:
    run: [view, $TARGET]
    nonsense: 1
`);
  const result = await host().handle({ op: 'open', target: join(root, 'docs', 'README.md'), cwd: root });
  expect(result).toMatchObject({ status: 'ok', scope: 'builtin' });
  expect(result.status === 'ok' && result.warnings).toEqual([expect.stringContaining('nonsense')]);
});
