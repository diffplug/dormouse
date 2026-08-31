import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  repo = await mkdtemp(join(tmpdir(), 'dor-tool-host-'));
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
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo, upstreamUrl: null });
    expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'ok',
      run: 'pnpm storybook',
      key: ['storybook', repo],
    });
  });

  it('reports a null key for an entry that declared none', async () => {
    const host = createToolHost({ stateDir });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo, upstreamUrl: null });
    const result = await host.handle({ op: 'lookup', name: 'scratch', cwd: repo });
    expect(result).toMatchObject({ status: 'ok', key: null });
  });

  it('carries lint warnings through to the caller', async () => {
    const host = createToolHost({ stateDir });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo, upstreamUrl: null });
    const result = await host.handle({ op: 'lookup', name: 'noisy', cwd: repo });
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status !== 'ok') return;
    expect(result.warnings).toEqual([expect.stringContaining("unknown field 'colour'")]);
  });


  it('persists trust to the state directory, surviving a host restart', async () => {
    await createToolHost({ stateDir }).handle({ op: 'trust', kind: 'folder', projectRoot: repo, upstreamUrl: null });
    expect(await createToolHost({ stateDir }).handle({ op: 'lookup', name: 'storybook', cwd: repo })).toMatchObject({
      status: 'ok',
    });
  });

  it('forgets trust between runs when the host has no state directory', async () => {
    const first = createToolHost();
    await first.handle({ op: 'trust', kind: 'folder', projectRoot: repo, upstreamUrl: null });
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
