import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileToolTrustStore, MemoryToolTrustStore, findToolFile, lookupTool } from './tool-trust';

const YML = `
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $PROJECT_ROOT]
  once:
    run: echo hi
`;

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dor-tool-trust-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findToolFile', () => {
  it('walks up from a nested cwd to the nearest dormouse.yml', async () => {
    await writeFile(join(root, 'dormouse.yml'), YML);
    const nested = join(root, 'lib', 'src');
    await mkdir(nested, { recursive: true });
    const found = await findToolFile(nested);
    expect(found?.dir).toBe(root);
    expect(found?.text).toContain('storybook');
  });

  it('is null when no file exists up to the filesystem root', async () => {
    expect(await findToolFile(root)).toBeNull();
  });

  it('stops at the nearest file rather than the outermost', async () => {
    await writeFile(join(root, 'dormouse.yml'), YML);
    const inner = join(root, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'dormouse.yml'), 'tools:\n  t:\n    run: x\n');
    expect((await findToolFile(inner))?.dir).toBe(inner);
  });
});

describe('FileToolTrustStore', () => {
  it('is unknown until a decision is recorded, then remembers it across instances', async () => {
    const stateDir = join(root, 'state');
    const store = new FileToolTrustStore(stateDir);
    expect(await store.get('/repo')).toBe('unknown');
    await store.set('/repo', 'trusted');
    expect(await store.get('/repo')).toBe('trusted');
    expect(await new FileToolTrustStore(stateDir).get('/repo')).toBe('trusted');
  });

  it('remembers a denial, so a hostile repo cannot re-ask every invocation', async () => {
    const store = new FileToolTrustStore(join(root, 'state'));
    await store.set('/repo', 'denied');
    expect(await store.get('/repo')).toBe('denied');
  });

  it('keys on the resolved path', async () => {
    const store = new FileToolTrustStore(join(root, 'state'));
    await store.set('/repo/../repo', 'trusted');
    expect(await store.get('/repo')).toBe('trusted');
  });

  it('starts empty on a corrupt file rather than failing every tool', async () => {
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'tool-trust.json'), '{not json');
    expect(await new FileToolTrustStore(stateDir).get('/repo')).toBe('unknown');
  });
});

describe('lookupTool', () => {
  const write = (text = YML) => writeFile(join(root, 'dormouse.yml'), text);

  it('reports no-file when there is nothing to read', async () => {
    expect(await lookupTool('storybook', root, new MemoryToolTrustStore())).toEqual({ status: 'no-file' });
  });

  it('asks for trust before running anything, naming the command', async () => {
    await write();
    expect(await lookupTool('storybook', root, new MemoryToolTrustStore())).toMatchObject({
      status: 'untrusted',
      projectRoot: root,
      name: 'storybook',
      run: 'pnpm storybook',
    });
  });

  it('resolves once the repo is trusted', async () => {
    await write();
    const trust = new MemoryToolTrustStore();
    await trust.set(root, 'trusted');
    const result = await lookupTool('storybook', root, trust);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.file.tools.get('storybook')?.run).toBe('pnpm storybook');
    expect(result.projectRoot).toBe(root);
  });

  it('stays denied once denied', async () => {
    await write();
    const trust = new MemoryToolTrustStore();
    await trust.set(root, 'denied');
    expect((await lookupTool('storybook', root, trust)).status).toBe('denied');
  });

  it('reports an unknown tool with the names it does know, before any trust check', async () => {
    await write();
    expect(await lookupTool('nope', root, new MemoryToolTrustStore())).toMatchObject({
      status: 'unknown-tool',
      names: ['once', 'storybook'],
    });
  });

  it('surfaces a parse error as an error rather than throwing', async () => {
    await write('tools:\n  t:\n    run: x\n    prespawn_dedupe: [$NOPE]\n');
    const result = await lookupTool('t', root, new MemoryToolTrustStore());
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    expect(result.message).toMatch(/unknown substitution '\$NOPE'/);
  });
});
