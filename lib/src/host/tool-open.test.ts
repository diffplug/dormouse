import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolHost } from './tool-host';

const hostname = vi.hoisted(() => vi.fn(() => 'Dev-Box.local'));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), hostname }));

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

it.each(['https://example.com/file.md', 'file://elsewhere.example/etc/passwd', 'surface:3', 'missing.md'])('rejects %s as a local target', async target => {
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

it('reports the canonical target an open resolved, for the preview slot, and none for a named lookup', async () => {
  const target = join(root, 'docs', 'README.md');
  const spelled = join('docs', '..', 'docs', 'README.md');
  expect(await host().handle({ op: 'open', target: spelled, cwd: root })).toMatchObject({ status: 'ok', scope: 'user', target });
  expect(await host().handle({ op: 'open', target: spelled, cwd: root, tool: 'builtin:file' })).toMatchObject({ status: 'ok', scope: 'builtin', target });
  const named = await host().handle({ op: 'lookup', name: 'markdown', cwd: root, args: [spelled], global: true });
  expect(named).toMatchObject({ status: 'ok', run: ['markdown', target] });
  expect(named).not.toHaveProperty('target');
});

describe('builtin:code', () => {
  it('opens any text format as source, Markdown and HTML included, keyed apart from builtin:file', async () => {
    await rm(config);
    const target = join(root, 'docs', 'README.md');
    expect(await host().handle({ op: 'open', target, cwd: root, tool: 'builtin:code' })).toMatchObject({
      status: 'ok', scope: 'builtin', name: 'code', run: ['dor', '__view-code', target], key: [target], target,
    });
    const page = join(root, 'index.html');
    await writeFile(page, '<p>hi</p>');
    await writeConfig('open:\n  - {match: "*.html", tool: "builtin:code"}\n');
    expect(await host().handle({ op: 'open', target: page, cwd: root })).toMatchObject({ status: 'ok', name: 'code' });
  });

  it('refuses binary files and folders', async () => {
    const image = join(root, 'a.png');
    await writeFile(image, 'png');
    expect(await host().handle({ op: 'open', target: image, cwd: root, tool: 'builtin:code' }))
      .toMatchObject({ status: 'error', message: expect.stringContaining("opens only text, not 'a.png'") });
    expect(await host().handle({ op: 'open', target: 'docs', cwd: root, tool: 'builtin:code' }))
      .toEqual({ status: 'error', message: "builtin:code cannot open the folder 'docs'; use builtin:folder" });
  });
});

describe('open-handlers', () => {
  const handlers = async (target: string, extra: { preview?: boolean } = {}) => {
    const result = await host().handle({ op: 'open-handlers', target, cwd: root, ...extra });
    if (result.status !== 'open-handlers') throw new Error(JSON.stringify(result));
    return result.handlers;
  };

  it('offers the default first, then later matching rules, then the built-ins, each once', async () => {
    await writeConfig(`tools:
  special:
    run: [special, $TARGET]
  markdown:
    run: [markdown, --watch, $TARGET]
  glance:
    run: [glance, $TARGET]
open:
  - {match: docs/README.md, tool: special}
  - {match: '*.txt', tool: glance}
  - {match: '**/*.md', tool: markdown, preview: glance}
  - {match: '*.md', tool: builtin:file}
`);
    const target = join(root, 'docs', 'README.md');
    expect(await handlers('docs/README.md')).toEqual({
      target, directory: false, config, warnings: [],
      handlers: [
        { tool: 'special', description: 'special $TARGET', reason: "open rule 1, 'docs/README.md'" },
        { tool: 'markdown', description: 'markdown --watch $TARGET', reason: "open rule 3, '**/*.md'" },
        { tool: 'glance', description: 'glance $TARGET', reason: "preview handler of open rule 3, '**/*.md'" },
        { tool: 'builtin:file', description: 'Markdown editor', reason: "open rule 4, '*.md'" },
        { tool: 'builtin:code', description: 'code editor (source)', reason: 'built-in' },
      ],
    });
    // The first handler is always what dor open selects.
    expect(await host().handle({ op: 'open', target, cwd: root })).toMatchObject({ name: 'special' });
  });

  it('puts the first rule\'s preview handler first for a preview', async () => {
    await writeConfig(viewerConfig('*.md').replace('tool: viewer}', "tool: viewer, preview: 'builtin:file'}"));
    expect((await handlers('docs/README.md', { preview: true })).handlers.map(handler => handler.tool)).toEqual(['builtin:file', 'viewer', 'builtin:code']);
    expect(await host().handle({ op: 'open', target: 'docs/README.md', cwd: root, preview: true })).toMatchObject({ scope: 'builtin', name: 'file' });
  });

  it('says when only a built-in matches, and offers nothing for what nothing opens', async () => {
    await rm(config);
    expect(await handlers('docs/README.md')).toMatchObject({ handlers: [
      { tool: 'builtin:file', description: 'Markdown editor', reason: 'built-in; no open rule matches' },
      { tool: 'builtin:code', reason: 'built-in' },
    ] });
    const source = join(root, 'main.ts');
    await writeFile(source, '');
    expect((await handlers(source)).handlers).toEqual([{ tool: 'builtin:file', description: 'code editor', reason: 'built-in; no open rule matches' }]);
    const binary = join(root, 'x.bin');
    await writeFile(binary, '');
    expect((await handlers(binary)).handlers).toEqual([]);
    expect((await handlers('docs')).handlers).toEqual([{ tool: 'builtin:folder', description: 'folder viewer', reason: 'built-in; no open rule matches' }]);
  });

  it('reports a target that does not exist as an error', async () => {
    expect(await host().handle({ op: 'open-handlers', target: 'missing.md', cwd: root })).toMatchObject({ status: 'error' });
  });
});

describe('folders', () => {
  const folderConfig = (...rules: string[]) => `tools:
  browse:
    run: [browse, $TARGET]
  quick:
    run: [quick, $TARGET]
  viewer:
    run: [view, $TARGET]
open:
${rules.map(rule => `  - ${rule}\n`).join('')}`;
  const open = (target: string, extra: { tool?: string; preview?: boolean; cwd?: string } = {}) =>
    host().handle({ op: 'open', target, cwd: root, ...extra });

  it('matches a folder rule against the name and both path forms, suffixed', async () => {
    const docs = join(root, 'docs');
    await writeConfig(folderConfig("{match: 'docs.📁', tool: browse}"));
    expect(await open('docs')).toMatchObject({ status: 'ok', name: 'browse', run: ['browse', docs], key: null, target: docs });
    await mkdir(join(root, 'docs', 'sub'));
    await writeConfig(folderConfig("{match: 'docs/sub.📁', tool: browse}"));
    expect(await open(join(root, 'docs', 'sub'))).toMatchObject({ status: 'ok', name: 'browse' });
    await mkdir(join(root, 'work'));
    await writeConfig(folderConfig(`{match: '${docs.replace(/\\/g, '/')}.📁', tool: browse}`));
    expect(await open('../docs', { cwd: join(root, 'work') })).toMatchObject({ status: 'ok', name: 'browse' });
  });

  it('never lets a file rule capture a folder, or a folder rule a file', async () => {
    await writeConfig(folderConfig("{match: '*', tool: viewer}", "{match: '**', tool: viewer}", "{match: '**/*', tool: viewer}"));
    expect(await open('docs')).toMatchObject({ status: 'ok', name: 'folder', scope: 'builtin' });
    const named = join(root, 'x.📁');
    await writeFile(named, 'a file');
    await writeConfig(folderConfig("{match: '*.📁', tool: browse}", "{match: '**/*.📁', tool: browse}", "{match: '*', tool: viewer}"));
    expect(await open('x.📁')).toMatchObject({ status: 'ok', name: 'viewer', run: ['view', named] });
  });

  it('follows the dotfile rule: *.📁 skips a dot-directory, .*.📁 names it', async () => {
    const config = join(root, '.config');
    await mkdir(config);
    await writeConfig(folderConfig("{match: '*.📁', tool: browse}"));
    expect(await open('.config')).toMatchObject({ status: 'ok', name: 'folder', scope: 'builtin' });
    expect(await open('docs')).toMatchObject({ status: 'ok', name: 'browse' });
    await writeConfig(folderConfig("{match: '.*.📁', tool: browse}"));
    expect(await open('.config')).toMatchObject({ status: 'ok', name: 'browse', run: ['browse', config] });
  });

  it.each(['no rule', 'builtin:folder'] as const)('opens the built-in folder viewer by %s', async selection => {
    const docs = join(root, 'docs');
    if (selection === 'builtin:folder') await writeConfig(folderConfig("{match: '*.📁', tool: 'builtin:folder'}"));
    expect(await open('docs')).toEqual({
      status: 'ok', projectRoot: root, path: '<built-in>', name: 'folder', scope: 'builtin',
      run: ['dor', '__view-folder', docs], key: [docs], render: 'iframe', port: 'announced', target: docs, warnings: [],
    });
    expect(await open('docs', { tool: 'builtin:folder' })).toMatchObject({ status: 'ok', scope: 'builtin', name: 'folder' });
  });

  it('refuses the built-in handler of the other kind, naming the one that fits', async () => {
    expect(await open('docs', { tool: 'builtin:file' })).toEqual({ status: 'error', message: "builtin:file cannot open the folder 'docs'; use builtin:folder" });
    expect(await open('docs/README.md', { tool: 'builtin:folder' }))
      .toEqual({ status: 'error', message: "builtin:folder cannot open the file 'docs/README.md'; use builtin:file" });
  });

  it('uses a rule\'s preview handler only for a preview, and never over --tool', async () => {
    const docs = join(root, 'docs');
    await writeConfig(folderConfig("{match: '*.📁', tool: browse, preview: quick}", "{match: '*.md', tool: viewer, preview: 'builtin:file'}"));
    expect(await open('docs')).toMatchObject({ status: 'ok', name: 'browse', run: ['browse', docs] });
    expect(await open('docs', { preview: true })).toMatchObject({ status: 'ok', name: 'quick', run: ['quick', docs] });
    expect(await open('docs', { preview: true, tool: 'browse' })).toMatchObject({ status: 'ok', name: 'browse' });
    expect(await open('docs/README.md')).toMatchObject({ status: 'ok', name: 'viewer' });
    expect(await open('docs/README.md', { preview: true })).toMatchObject({ status: 'ok', scope: 'builtin', name: 'file' });
    await writeConfig(folderConfig("{match: '*.📁', tool: browse}"));
    expect(await open('docs', { preview: true })).toMatchObject({ status: 'ok', name: 'browse' });
  });
});

describe('file URLs', () => {
  let target: string;
  /** Open the `file:` URL a terminal link carries for `target`, naming `hostName`. */
  const openLink = (hostName: string, extra: { preview?: boolean } = {}) =>
    host().handle({ op: 'open', target: `file://${hostName}${pathToFileURL(target).pathname}`, cwd: root, ...extra });
  beforeEach(async () => {
    await writeConfig(viewerConfig('*.md'));
    target = join(root, 'docs', 'my notes.md');
    await writeFile(target, 'hi');
  });

  it('opens a local file URL as its decoded path, through the open rules', async () => {
    expect(await openLink('')).toMatchObject({ status: 'ok', run: ['view', target], target });
    expect(await openLink('dev-box.local', { preview: true })).toMatchObject({ status: 'ok', run: ['view', target], target });
  });

  it('refuses a file URL naming another host', async () => {
    expect(await openLink('elsewhere.example')).toEqual({ status: 'error', message: expect.stringContaining('not a file on this machine') });
  });
});
