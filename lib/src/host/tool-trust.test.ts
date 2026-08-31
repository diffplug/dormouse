import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileToolTrustStore,
  MemoryToolTrustStore,
  findToolFile,
  folderGrantKey,
  lookupTool,
  upstreamGrantKey,
} from './tool-trust';

/** No git in these fixtures; the folder grant is the only key unless stated. */
const noUpstream = async () => null;

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
  it('is untrusted until a grant is recorded, then remembers it across instances', async () => {
    const stateDir = join(root, 'state');
    const key = folderGrantKey('/repo');
    expect(await new FileToolTrustStore(stateDir).isTrusted([key])).toBe(false);
    await new FileToolTrustStore(stateDir).grant(key, 'folder');
    expect(await new FileToolTrustStore(stateDir).isTrusted([key])).toBe(true);
  });

  it('shares one upstream grant across every checkout — the point of the change', async () => {
    const store = new FileToolTrustStore(join(root, 'state'));
    const upstream = upstreamGrantKey('https://github.com/diffplug/dormouse');
    await store.grant(upstream, 'upstream');
    // A second worktree resolves the same upstream and a different folder.
    expect(await store.isTrusted([folderGrantKey('/w/two'), upstream])).toBe(true);
    // ...while an unrelated repo with no upstream grant does not.
    expect(await store.isTrusted([folderGrantKey('/w/other')])).toBe(false);
  });

  it('keys folder grants on the resolved path', async () => {
    const store = new FileToolTrustStore(join(root, 'state'));
    await store.grant(folderGrantKey('/repo/../repo'), 'folder');
    expect(await store.isTrusted([folderGrantKey('/repo')])).toBe(true);
  });

  it('keeps upstream and folder keys from colliding', async () => {
    const store = new FileToolTrustStore(join(root, 'state'));
    await store.grant(folderGrantKey('/repo'), 'folder');
    expect(await store.isTrusted([upstreamGrantKey('/repo')])).toBe(false);
  });

  it('starts empty on a corrupt file rather than failing every tool', async () => {
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'tool-trust.json'), '{not json');
    expect(await new FileToolTrustStore(stateDir).isTrusted([folderGrantKey('/repo')])).toBe(false);
  });

  it('migrates the pre-versioned shape, keeping grants and dropping denials', async () => {
    // v0 was `{ roots: Record<absPath, 'trusted' | 'denied'> }`. A stored denial
    // must not survive as anything: the state no longer exists, and nothing can
    // revoke or even list it.
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'tool-trust.json'),
      JSON.stringify({ roots: { '/old/yes': 'trusted', '/old/no': 'denied' } }),
    );
    const store = new FileToolTrustStore(stateDir);
    expect(await store.isTrusted([folderGrantKey('/old/yes')])).toBe(true);
    expect(await store.isTrusted([folderGrantKey('/old/no')])).toBe(false);
  });
});

describe('lookupTool', () => {
  const write = (text = YML) => writeFile(join(root, 'dormouse.yml'), text);

  it('reports no-file when there is nothing to read', async () => {
    expect(await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, noUpstream))
      .toEqual({ status: 'no-file' });
  });

  it('asks for trust before running anything, naming the command', async () => {
    await write();
    expect(await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, noUpstream))
      .toMatchObject({
        status: 'untrusted',
        projectRoot: root,
        name: 'storybook',
        run: 'pnpm storybook',
        upstreamUrl: null,
      });
  });

  it('offers the upstream when git resolves one', async () => {
    await write();
    const upstream = async () => 'https://github.com/diffplug/dormouse';
    expect(await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, upstream))
      .toMatchObject({ status: 'untrusted', upstreamUrl: 'https://github.com/diffplug/dormouse' });
  });

  it('runs when the upstream is granted, even in a folder never seen before', async () => {
    await write();
    const trust = new MemoryToolTrustStore();
    await trust.grant(upstreamGrantKey('https://github.com/diffplug/dormouse'), 'upstream');
    const upstream = async () => 'https://github.com/diffplug/dormouse';
    expect((await lookupTool('storybook', root, trust, undefined, upstream)).status).toBe('ok');
  });

  it('resolves once the folder is granted', async () => {
    await write();
    const trust = new MemoryToolTrustStore();
    await trust.grant(folderGrantKey(root), 'folder');
    const result = await lookupTool('storybook', root, trust, undefined, noUpstream);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entry.run).toBe('pnpm storybook');
    expect(result.projectRoot).toBe(root);
  });


  it('reports an unknown tool with the names it does know, before any trust check', async () => {
    await write();
    expect(await lookupTool('nope', root, new MemoryToolTrustStore(), undefined, noUpstream)).toMatchObject({
      status: 'unknown-tool',
      names: ['once', 'storybook'],
    });
  });

  it('surfaces a parse error as an error rather than throwing', async () => {
    await write('tools:\n  t:\n    run: x\n    prespawn_dedupe: [$NOPE]\n');
    const result = await lookupTool('t', root, new MemoryToolTrustStore(), undefined, noUpstream);
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    expect(result.message).toMatch(/unknown substitution '\$NOPE'/);
  });
});

describe('the pre-approval read (regression: review finding 13, PR #493 review)', () => {
  it('refuses at stat, before the file is ever read', async () => {
    // Read before the trust check, so its size is chosen by a repo nobody has
    // approved yet; parsing a huge one would OOM the host and take every PTY.
    await writeFile(join(root, 'dormouse.yml'), `# ${'x'.repeat(300_000)}\n`);
    const result = await lookupTool('storybook', root, new MemoryToolTrustStore());
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    // Naming the check that fired is the assertion: a status alone is produced
    // by the post-read fallback too, so it would stay green with the stat
    // removed — the exact regression this block exists for.
    expect(result.message).toMatch(/larger than \d+ bytes$/);
  });

  it('still reads a normal file', async () => {
    await writeFile(join(root, 'dormouse.yml'), YML);
    expect((await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, noUpstream)).status).toBe('untrusted');
  });

  it('measures bytes, not UTF-16 code units', async () => {
    // Injected reader, so `stat` never runs and `Buffer.byteLength` is the only
    // check standing. 100k four-byte characters: well under the cap by
    // `.length`, well over it by bytes. Counting code units would let it through.
    const oversized = `# ${'\u{1F600}'.repeat(100_000)}\n`;
    const result = await lookupTool('storybook', root, new MemoryToolTrustStore(), async () => oversized, noUpstream);
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    expect(result.message).toMatch(/after reading$/);
  });
});
