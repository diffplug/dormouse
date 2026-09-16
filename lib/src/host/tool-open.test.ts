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

it('matches catch-all rules above the invocation directory and canonical absolute rules', async () => {
  await mkdir(join(root, 'work'));
  await writeConfig(viewerConfig('**/*.md'));
  const request = { op: 'open', target: '../docs/README.md', cwd: join(root, 'work') } as const;
  expect(await host().handle(request)).toMatchObject({ status: 'ok', name: 'viewer' });
  await writeConfig(viewerConfig(join(root, 'docs').replace(/\\/g, '/') + '/**'));
  expect(await host().handle(request)).toMatchObject({ status: 'ok', name: 'viewer' });
});
