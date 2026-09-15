import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolHost } from './tool-host';

const YML = `
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $PROJECT_ROOT]
  scratch:
    run: echo hi
  noisy:
    run: echo noisy
    colour: blue
`;

let repo = '';
let stateDir = '';

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'dor-tool-host-')));
  stateDir = join(repo, '.state');
  await writeFile(join(repo, 'dormouse.yml'), YML);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('createToolHost', () => {
  it('asks for trust before resolving anything runnable', async () => {
    const host = createToolHost({ stateDir });
    expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'untrusted',
      run: 'pnpm storybook',
      projectRoot: repo,
    });
  });

  it('renders the key host-side once trusted, so the webview never sees a template', async () => {
    const host = createToolHost({ stateDir });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'ok',
      run: 'pnpm storybook',
      key: ['storybook', repo],
    });
  });

  it('resolves an upstream grant host-side', async () => {
    const host = createToolHost({ stateDir });
    // This fixture is not a git checkout, so an upstream choice must fall back
    // to a folder grant.
    await host.handle({
      op: 'trust',
      kind: 'upstream',
      projectRoot: repo,
    });

    expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'ok',
    });
  });

  it('reports a null key for an entry that declared none', async () => {
    const host = createToolHost({ stateDir });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    const result = await host.handle({ op: 'lookup', name: 'scratch', cwd: repo });
    expect(result).toMatchObject({ status: 'ok', key: null });
  });

  it('carries lint warnings through to the caller', async () => {
    const host = createToolHost({ stateDir });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    const result = await host.handle({ op: 'lookup', name: 'noisy', cwd: repo });
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status !== 'ok') return;
    expect(result.warnings).toEqual([expect.stringContaining("unknown field 'colour'")]);
  });


  it('persists trust to the state directory, surviving a host restart', async () => {
    await createToolHost({ stateDir }).handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await createToolHost({ stateDir }).handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'ok',
    });
  });

  it('forgets trust between runs when the host has no state directory', async () => {
    const first = createToolHost();
    await first.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await first.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({ status: 'ok' });
    expect(await createToolHost().handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'untrusted',
    });
  });

  it('reports an unknown tool with the names it knows', async () => {
    const result = await createToolHost({ stateDir }).handle({ op: 'lookup', name: 'nope', cwd: repo });
    expect(result).toMatchObject({ status: 'unknown-tool', names: ['noisy', 'scratch', 'storybook'] });
  });

  it('reports no-file above any dormouse.yml', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dor-tool-empty-'));
    try {
      expect(await createToolHost({ stateDir }).handle({ op: 'lookup', name: 'x', cwd: empty })).toEqual({
        status: 'no-file',
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('returns a parse error rather than throwing across the wire', async () => {
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  t:\n    run: x\n    prespawn_dedupe: [$NOPE]\n');
    const result = await createToolHost({ stateDir }).handle({ op: 'lookup', name: 't', cwd: repo });
    expect(result).toMatchObject({ status: 'error' });
  });
});

it('resolves user tools without repo approval and keeps explicit project names ahead of them', async () => {
  const path = join(repo, 'user.yml');
  await writeFile(path, `tools:\n  storybook:\n    run: [user-storybook, $ARGS]\n  viewer:\n    run: [viewer, $TARGET]\n    prespawn_dedupe: [$TARGET]\n`);
  const target = join(repo, 'a b; $(echo bad).md');
  await writeFile(target, 'hello');
  const host = createToolHost({ stateDir, userConfigPath: path });
  expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({ status: 'untrusted', run: 'pnpm storybook' });
  expect(await host.handle({ op: 'lookup', name: 'storybook', global: true, cwd: repo, args: ['--port', '1234'] }))
    .toMatchObject({ status: 'ok', scope: 'user', run: ['user-storybook', '--port', '1234'] });
  expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo, args: ['a b; $(echo bad).md'] }))
    .toMatchObject({ status: 'ok', scope: 'user', run: ['viewer', target], key: [target] });
  expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo, args: ['https://example.com/a.md'] }))
    .toMatchObject({ status: 'error', message: expect.stringContaining('local file') });
  expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo, args: [] }))
    .toMatchObject({ status: 'error', message: expect.stringContaining('exactly one') });
});

it('re-resolves input argv after project approval without shell interpolation', async () => {
  await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  viewer:\n    run: [viewer, $TARGET]\n    prespawn_dedupe: [$PROJECT_ROOT, $TARGET]\n');
  const target = join(repo, "quoted ' document.md");
  await writeFile(target, 'hello');
  const host = createToolHost({ stateDir });
  const request = { op: 'lookup' as const, name: 'viewer', cwd: repo, args: [target] };
  expect(await host.handle(request)).toMatchObject({ status: 'untrusted', run: ['viewer', target] });
  await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
  expect(await host.handle(request)).toMatchObject({ status: 'ok', run: ['viewer', target], key: [repo, target] });
});

it('does not silently ignore malformed user configuration or input to shell strings', async () => {
  const path = join(repo, 'user.yml');
  const host = createToolHost({ stateDir, userConfigPath: path });
  await writeFile(path, 'tools:\n  viewer:\n    run: [viewer, $PROJECT_ROOT]\n');
  expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo })).toMatchObject({ status: 'error' });
  expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo, args: ['input'] }))
    .toMatchObject({ status: 'error', message: expect.stringContaining('argument-list run') });
});
