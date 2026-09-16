import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('lands concurrent grants for different keys without a lock between them', async () => {
    const stateDir = join(root, 'state');
    const first = new FileToolTrustStore(stateDir);
    const second = new FileToolTrustStore(stateDir);
    const folder = folderGrantKey('/repo/one');
    const upstream = upstreamGrantKey('https://github.com/diffplug/dormouse');

    await Promise.all([
      first.grant(folder, 'folder'),
      second.grant(upstream, 'upstream'),
    ]);

    const reader = new FileToolTrustStore(stateDir);
    expect(await reader.isTrusted([folder])).toBe(true);
    expect(await reader.isTrusted([upstream])).toBe(true);
    // Long-lived instances also re-read the directory instead of retaining a
    // cache that cannot observe another window's grant.
    expect(await first.isTrusted([upstream])).toBe(true);
  });

  it('is idempotent: granting the same key twice leaves one grant', async () => {
    const stateDir = join(root, 'state');
    const key = folderGrantKey('/repo');
    const store = new FileToolTrustStore(stateDir);
    await store.grant(key, 'folder');
    await Promise.all([store.grant(key, 'folder'), new FileToolTrustStore(stateDir).grant(key, 'folder')]);

    expect(await store.isTrusted([key])).toBe(true);
    // One file per grant, and no temp file left behind by the repeat writes.
    expect(await readdir(join(stateDir, 'tool-trust'))).toHaveLength(1);
  });

  it('ignores files outside the expected grant path', async () => {
    // Every grant is named for the hash of its key, so nothing an unrelated
    // writer drops in the directory can vouch for a key.
    const stateDir = join(root, 'state');
    const trustDir = join(stateDir, 'tool-trust');
    await mkdir(trustDir, { recursive: true });
    await writeFile(join(trustDir, 'tool-trust.json'), '{not json');
    await writeFile(join(trustDir, 'deadbeef.json'), JSON.stringify({ version: 1, key: folderGrantKey('/repo'), kind: 'folder' }));

    const store = new FileToolTrustStore(stateDir);
    expect(await store.isTrusted([folderGrantKey('/repo')])).toBe(false);
    expect(await store.isTrusted([upstreamGrantKey('https://github.com/diffplug/dormouse')])).toBe(false);
  });

  it('validates the receipt at the exact grant path and still checks other covering keys', async () => {
    const stateDir = join(root, 'state');
    const key = folderGrantKey('/repo');
    const store = new FileToolTrustStore(stateDir);
    await store.grant(key, 'folder');
    const [name] = await readdir(join(stateDir, 'tool-trust'));
    const path = join(stateDir, 'tool-trust', name);
    const valid = JSON.parse(await readFile(path, 'utf8'));
    const upstream = upstreamGrantKey('https://github.com/diffplug/dormouse');
    await store.grant(upstream, 'upstream');

    for (const invalid of [
      '', '{not json', 'null', '[]', '{}',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, key: folderGrantKey('/other') }),
      JSON.stringify({ ...valid, kind: 'upstream' }),
      JSON.stringify({ ...valid, kind: 'unknown' }),
      JSON.stringify({ ...valid, grantedAt: undefined }),
      JSON.stringify({ ...valid, grantedAt: 0 }),
      JSON.stringify({ ...valid, padding: 'x'.repeat(256 * 1024) }),
    ]) {
      await writeFile(path, invalid);
      expect(await store.isTrusted([key])).toBe(false);
      expect(await store.isTrusted([key, upstream])).toBe(true);
    }
    await writeFile(path, JSON.stringify(valid));
    expect(await store.isTrusted([key])).toBe(true);
  });

  it('does not accept a directory at the exact grant path', async () => {
    const stateDir = join(root, 'state');
    const key = folderGrantKey('/repo');
    const store = new FileToolTrustStore(stateDir);
    await store.grant(key, 'folder');
    const [name] = await readdir(join(stateDir, 'tool-trust'));
    const path = join(stateDir, 'tool-trust', name);
    await rm(path);
    await mkdir(path);
    expect(await store.isTrusted([key])).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlink receipt even when its target is a valid grant', async () => {
    const stateDir = join(root, 'state');
    const key = folderGrantKey('/repo');
    const store = new FileToolTrustStore(stateDir);
    await store.grant(key, 'folder');
    const [name] = await readdir(join(stateDir, 'tool-trust'));
    const path = join(stateDir, 'tool-trust', name);
    const target = join(root, 'another-file.json');
    await writeFile(target, await readFile(path));
    await rm(path);
    await symlink(target, path);
    expect(await store.isTrusted([key])).toBe(false);
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

  it('does not spawn git once the folder grant already answers', async () => {
    await write();
    const trust = new MemoryToolTrustStore();
    await trust.grant(folderGrantKey(root), 'folder');
    // `resolveUpstreamUrl` is two `git` subprocesses on every named invocation.
    const upstream = vi.fn(async () => 'https://github.com/diffplug/dormouse');
    expect((await lookupTool('storybook', root, trust, undefined, upstream)).status).toBe('ok');
    expect(upstream).not.toHaveBeenCalled();
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
  it('refuses via fstat, before the file contents are read', async () => {
    // Read before the trust check, so its size is chosen by a repo nobody has
    // approved yet; parsing a huge one would OOM the host and take every PTY.
    await writeFile(join(root, 'dormouse.yml'), `# ${'x'.repeat(300_000)}\n`);
    const result = await lookupTool('storybook', root, new MemoryToolTrustStore());
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    // Naming the check that fired is the assertion: a status alone is produced
    // by the post-read fallback too, so it would stay green with the fstat
    // removed — the exact regression this block exists for.
    expect(result.message).toMatch(/larger than \d+ bytes$/);
  });

  it('still reads a normal file', async () => {
    await writeFile(join(root, 'dormouse.yml'), YML);
    expect((await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, noUpstream)).status).toBe('untrusted');
  });

  it('refuses a symlink instead of following it before trust', async () => {
    const target = join(root, 'repo-controlled-target.yml');
    await writeFile(target, YML);
    await symlink(target, join(root, 'dormouse.yml'));

    const result = await lookupTool('storybook', root, new MemoryToolTrustStore(), undefined, noUpstream);
    expect(result).toMatchObject({ status: 'error' });
    if (result.status !== 'error') return;
    expect(result.message).toMatch(/must be a regular file, not a symbolic link$/);
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
