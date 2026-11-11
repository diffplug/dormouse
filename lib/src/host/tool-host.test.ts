import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolHost } from './tool-host';

const YML = `
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $HERE]
  scratch:
    run: echo hi
  noisy:
    run: echo noisy
    colour: blue
`;

let repo = '';
let stateDir = '';
/** A user file outside the project root, which project discovery never reads. */
const userFile = (name: string) => join(repo, 'user', name);

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'dor-tool-host-')));
  stateDir = join(repo, '.state');
  await writeFile(join(repo, 'dormouse.yml'), YML);
  await mkdir(join(repo, 'user'));
  // A host built without `userConfigPath` reads the real user file; point it
  // into the fixture so a developer's own Tools can't change these results.
  vi.stubEnv('XDG_CONFIG_HOME', join(repo, '.config'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
});

describe('createToolHost', () => {
  it('reads browser settings before any Tool execution grant and merges user presets', async () => {
    const userConfigPath = userFile('user.yml');
    await writeFile(userConfigPath, 'browser:\n  viewports:\n    custom: { width: 1100, height: 800, dpr: 2 }\n');
    await writeFile(join(repo, 'dormouse.yml'), 'browser:\n  default_viewport: custom\n');
    const host = createToolHost({ userConfigPath });
    expect(await host.handle({ op: 'browser-config', cwd: repo })).toMatchObject({
      status: 'browser-config', config: { defaultViewport: 'custom', viewports: { custom: { width: 1100, height: 800, dpr: 2 } } },
    });
  });

  it('reads browser preferences despite invalid unrelated Tool entries in either file', async () => {
    const userConfigPath = userFile('user.yml');
    await writeFile(userConfigPath, 'browser:\n  viewports:\n    custom: { width: 1600, height: 1000 }\ntools:\n  broken:\n    render: ab-screencast\n');
    await writeFile(join(repo, 'dormouse.yml'), 'browser:\n  default_viewport: custom\ntools:\n  broken:\n    run: pnpm dev\n    render: ab-screencast\n');
    const host = createToolHost({ userConfigPath });
    expect(await host.handle({ op: 'browser-config', cwd: repo })).toMatchObject({
      status: 'browser-config', config: { defaultViewport: 'custom', viewports: { custom: { width: 1600, height: 1000 } } },
    });
    expect(await host.handle({ op: 'lookup', name: 'broken', cwd: repo })).toMatchObject({ status: 'error', message: expect.stringContaining("'render' must be one of") });
    expect(await host.handle({ op: 'lookup', name: 'broken', cwd: repo, global: true })).toMatchObject({ status: 'error', message: expect.stringContaining("'run' is required") });
  });

  it('still reports invalid browser sections and malformed YAML explicitly', async () => {
    const host = createToolHost({ userConfigPath: userFile('missing-user.yml') });
    await writeFile(join(repo, 'dormouse.yml'), 'browser:\n  viewports:\n    broken: { width: 0, height: 900 }\ntools:\n  valid:\n    run: echo ok\n');
    expect(await host.handle({ op: 'browser-config', cwd: repo })).toMatchObject({ status: 'error', message: expect.stringContaining('browser.viewports.broken') });
    await writeFile(join(repo, 'dormouse.yml'), 'browser: [invalid\n');
    expect(await host.handle({ op: 'browser-config', cwd: repo })).toMatchObject({ status: 'error', message: expect.stringContaining('dormouse.yml') });
  });

  it('resolves a trusted Tool viewport from project and user configuration', async () => {
    const userConfigPath = userFile('user.yml');
    await writeFile(userConfigPath, 'browser:\n  viewports:\n    custom: { width: 1100, height: 800 }\n');
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  app:\n    run: pnpm dev\n    render: playwright-screencast\n    viewport: custom\n');
    const host = createToolHost({ userConfigPath });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await host.handle({ op: 'lookup', name: 'app', cwd: repo })).toMatchObject({
      status: 'ok', render: 'playwright-screencast', viewport: { mode: 'fixed', width: 1100, height: 800 },
    });
  });

  it('resolves a trusted project Tool beside an invalid unrelated user Tool, keeping the user presets', async () => {
    const userConfigPath = userFile('user.yml');
    await writeFile(userConfigPath, 'browser:\n  viewports:\n    custom: { width: 1100, height: 800 }\ntools:\n  broken:\n    render: ab-screencast\n');
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  app:\n    run: pnpm dev\n    render: playwright-screencast\n    viewport: custom\n');
    const host = createToolHost({ stateDir, userConfigPath });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await host.handle({ op: 'lookup', name: 'app', cwd: repo })).toMatchObject({
      status: 'ok', viewport: { mode: 'fixed', width: 1100, height: 800 },
    });
  });

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

  it('names the user configuration and available tools after a project-file miss', async () => {
    await rm(join(repo, 'dormouse.yml'));
    const path = userFile('user.yml');
    await writeFile(path, 'tools:\n  viewer:\n    run: viewer\n');
    expect(await createToolHost({ stateDir, userConfigPath: path }).handle({ op: 'lookup', name: 'viewr', cwd: repo }))
      .toEqual({ status: 'unknown-tool', projectRoot: dirname(path), path, names: ['viewer'] });
  });

  it('returns a parse error rather than throwing across the wire', async () => {
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  t:\n    run: x\n    prespawn_dedupe: [$NOPE]\n');
    const result = await createToolHost({ stateDir }).handle({ op: 'lookup', name: 't', cwd: repo });
    expect(result).toMatchObject({ status: 'error' });
  });

  it('resolves user tools without repo approval and keeps explicit project names ahead of them', async () => {
    const path = userFile('user.yml');
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
      .toMatchObject({ status: 'error', message: expect.stringContaining('local path') });
    expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo, args: [] }))
      .toMatchObject({ status: 'error', message: expect.stringContaining('exactly one') });
  });

  it('substitutes the user file\'s own directory for $HERE in a user Tool', async () => {
    const userDir = join(repo, 'config');
    await mkdir(userDir);
    const path = join(userDir, 'dormouse.yml');
    await writeFile(path, 'tools:\n  pridm:\n    run: [node, $HERE/pridm/main.js, $CWD]\n    prespawn_dedupe: [pridm, $HERE]\n');
    const cwd = join(repo, 'work');
    await mkdir(cwd);
    expect(await createToolHost({ stateDir, userConfigPath: path }).handle({ op: 'lookup', name: 'pridm', cwd, global: true }))
      .toMatchObject({ status: 'ok', scope: 'user', run: ['node', join(userDir, 'pridm', 'main.js'), cwd], key: ['pridm', userDir], warnings: [] });
  });

  it('re-resolves input argv after project approval without shell interpolation', async () => {
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  viewer:\n    run: [viewer, $TARGET]\n    prespawn_dedupe: [$HERE, $TARGET]\n');
    const target = join(repo, "quoted ' document.md");
    await writeFile(target, 'hello');
    const host = createToolHost({ stateDir });
    const request = { op: 'lookup' as const, name: 'viewer', cwd: repo, args: [target] };
    expect(await host.handle(request)).toMatchObject({ status: 'untrusted', run: ['viewer', target] });
    await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
    expect(await host.handle(request)).toMatchObject({ status: 'ok', run: ['viewer', target], key: [repo, target] });
  });

  it('does not silently ignore malformed user configuration or input to shell strings', async () => {
    const path = userFile('user.yml');
    const host = createToolHost({ stateDir, userConfigPath: path });
    await writeFile(path, 'tools:\n  viewer:\n    run: [viewer, $PROJECT_ROOT]\n');
    expect(await host.handle({ op: 'lookup', name: 'viewer', cwd: repo })).toMatchObject({ status: 'error' });
    expect(await host.handle({ op: 'lookup', name: 'storybook', cwd: repo, args: ['input'] }))
      .toMatchObject({ status: 'error', message: expect.stringContaining('argument-list run') });
  });

  it('validates target-only dedupe inputs before asking for project approval', async () => {
    await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  view:\n    run: [viewer, $ARGS]\n    prespawn_dedupe: [$TARGET]\n');
    const host = createToolHost({ stateDir });
    expect(await host.handle({ op: 'lookup', name: 'view', cwd: repo, args: ['missing.md'] }))
      .toMatchObject({ status: 'error', message: 'no such file or folder: missing.md' });
  });

  describe('a named lookup records its $TARGET as an open does', () => {
    let doc = '';
    beforeEach(async () => {
      await mkdir(join(repo, 'docs'));
      doc = join(repo, 'docs', 'a.md');
      await writeFile(doc, 'hello');
    });

    it('returns a project Tool\'s canonical target from a relative path', async () => {
      await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  view:\n    run: [viewer, $TARGET]\n');
      const host = createToolHost({ stateDir, userConfigPath: userFile('absent.yml') });
      await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
      expect(await host.handle({ op: 'lookup', name: 'view', cwd: join(repo, 'docs'), args: ['../docs/a.md'] }))
        .toMatchObject({ status: 'ok', run: ['viewer', doc], target: doc });
    });

    it.skipIf(process.platform === 'win32')('returns a user Tool\'s canonical target through a symlink, the answer its open gives', async () => {
      const path = userFile('user.yml');
      await writeFile(path, 'tools:\n  view:\n    run: [viewer, $TARGET]\n');
      await symlink(doc, join(repo, 'link.md'));
      const host = createToolHost({ userConfigPath: path });
      const named = await host.handle({ op: 'lookup', name: 'view', cwd: repo, args: ['link.md'], global: true });
      expect(named).toMatchObject({ status: 'ok', scope: 'user', run: ['viewer', doc], target: doc });
      expect(await host.handle({ op: 'open', target: 'link.md', cwd: repo, tool: 'view' })).toEqual(named);
    });

    it('returns the target of a Tool taking $TARGET only in its key', async () => {
      await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  view:\n    run: [viewer, $ARGS]\n    prespawn_dedupe: [$TARGET]\n');
      const host = createToolHost({ stateDir, userConfigPath: userFile('absent.yml') });
      await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
      expect(await host.handle({ op: 'lookup', name: 'view', cwd: repo, args: ['docs/a.md'] }))
        .toMatchObject({ status: 'ok', run: ['viewer', 'docs/a.md'], key: [doc], target: doc });
    });

    it('returns none for an $ARGS Tool given a path', async () => {
      const path = userFile('user.yml');
      await writeFile(path, 'tools:\n  view:\n    run: [viewer, $ARGS]\n');
      const result = await createToolHost({ userConfigPath: path }).handle({ op: 'lookup', name: 'view', cwd: repo, args: ['docs/a.md'], global: true });
      expect(result).toMatchObject({ status: 'ok', run: ['viewer', 'docs/a.md'] });
      expect(result.status === 'ok' && result.target).toBeUndefined();
    });

    it('returns an imported Tool\'s target', async () => {
      const path = userFile('user.yml');
      await mkdir(join(repo, 'user', 'lib'));
      await writeFile(join(repo, 'user', 'lib', 'dormouse.yml'), 'tools:\n  view:\n    run: [viewer, $TARGET]\n');
      await writeFile(path, 'tools:\n  view:\n    from: lib\n');
      expect(await createToolHost({ userConfigPath: path }).handle({ op: 'lookup', name: 'view', cwd: repo, args: ['docs/a.md'], global: true }))
        .toMatchObject({ status: 'ok', scope: 'user', path: join(repo, 'user', 'lib', 'dormouse.yml'), target: doc });
    });
  });

  it('names the actual user path when --global has no config', async () => {
    const path = userFile('absent-user.yml');
    expect(await createToolHost({ userConfigPath: path }).handle({ op: 'lookup', name: 'view', cwd: repo, global: true }))
      .toMatchObject({ status: 'unknown-tool', path, names: [] });
  });

  it.skipIf(process.platform === 'win32')('follows a user-config dotfiles symlink', async () => {
    const path = userFile('user-link.yml');
    const source = join(repo, 'dotfiles.yml');
    await writeFile(source, 'tools:\n  scratch:\n    run: echo hi\n');
    await symlink(source, path);
    const result = await createToolHost({ userConfigPath: path }).handle({ op: 'lookup', name: 'scratch', cwd: repo, global: true });
    expect(result).toMatchObject({ status: 'ok', scope: 'user', run: 'echo hi' });
  });

  describe('from inside the user config directory', () => {
    // `repo/dormouse.yml` sits above the user directory, so a walk that went
    // on past it would find a project file and an untrusted `scratch`.
    const OUTER = 'browser:\n  viewports:\n    outer: { width: 1000, height: 700 }\ntools:\n  scratch:\n    run: echo outer\n';
    const USER = 'browser:\n  viewports:\n    mine: { width: 1100, height: 800 }\ntools:\n  scratch:\n    run: echo user\n  md:\n    run: echo md\n';
    let userDir = '';
    let userConfigPath = '';

    beforeEach(async () => {
      await writeFile(join(repo, 'dormouse.yml'), OUTER);
      userDir = join(repo, 'home', '.config', 'dormouse');
      userConfigPath = join(userDir, 'dormouse.yml');
      await mkdir(join(userDir, 'tools', 'sub'), { recursive: true });
    });

    /** Every expected answer from `cwd`, against a host reading `userPath`. */
    async function expectUserOnly(cwd: string, userPath = userConfigPath) {
      const host = createToolHost({ stateDir, userConfigPath: userPath });
      expect(await host.handle({ op: 'lookup', name: 'scratch', cwd }))
        .toMatchObject({ status: 'ok', scope: 'user', run: 'echo user' });
      expect(await host.handle({ op: 'lookup', name: 'nope', cwd }))
        .toEqual(await host.handle({ op: 'lookup', name: 'nope', cwd, global: true }));
      expect(await host.handle({ op: 'list', cwd, global: false })).toMatchObject({ status: 'list', listing: {
        project: null,
        tools: [{ name: 'scratch', scope: 'user', shadowed: false }, { name: 'md', scope: 'user', shadowed: false }],
        warnings: [],
      } });
      const browser = await host.handle({ op: 'browser-config', cwd });
      expect(browser).toMatchObject({ status: 'browser-config', config: { viewports: { mine: { width: 1100, height: 800 } } } });
      expect(browser.status === 'browser-config' && browser.config.viewports.outer).toBeUndefined();
    }

    it('never resolves the user file as a project file, nor walks past its directory', async () => {
      await writeFile(userConfigPath, USER);
      await expectUserOnly(userDir);
      await expectUserOnly(join(userDir, 'tools', 'sub'));
    });

    it.skipIf(process.platform === 'win32')('excludes a user file that is a dotfiles symlink, by its configured directory', async () => {
      const dotfiles = join(repo, 'home', 'dotfiles');
      await mkdir(dotfiles, { recursive: true });
      await writeFile(join(dotfiles, 'dormouse.yml'), USER);
      await symlink(join(dotfiles, 'dormouse.yml'), userConfigPath);
      await expectUserOnly(join(userDir, 'tools', 'sub'));
      // Where the bytes live is an ordinary project directory.
      expect(await createToolHost({ stateDir, userConfigPath }).handle({ op: 'lookup', name: 'scratch', cwd: dotfiles }))
        .toMatchObject({ status: 'untrusted', projectRoot: dotfiles });
    });

    it.skipIf(process.platform === 'win32')('excludes the directory when the cwd reaches it through a symlink', async () => {
      await writeFile(userConfigPath, USER);
      const link = join(repo, 'home', 'link');
      await symlink(userDir, link);
      await expectUserOnly(join(link, 'tools', 'sub'));
    });

    it.skipIf(process.platform === 'win32')('excludes the directory when the configured path reaches it through a symlink', async () => {
      // `~/.config/dormouse` links to a real directory the cwd names directly.
      const real = join(repo, 'home', 'dotfiles', 'dormouse');
      await mkdir(join(real, 'tools', 'sub'), { recursive: true });
      await writeFile(join(real, 'dormouse.yml'), USER);
      await rm(userDir, { recursive: true });
      await symlink(real, userDir);
      await expectUserOnly(join(real, 'tools', 'sub'));
    });

    it('treats a nearer dormouse.yml below the user directory as an ordinary project file', async () => {
      await writeFile(userConfigPath, USER);
      const nested = join(userDir, 'tools');
      await writeFile(join(nested, 'dormouse.yml'), 'tools:\n  scratch:\n    run: echo nested\n');
      const host = createToolHost({ stateDir, userConfigPath });
      expect(await host.handle({ op: 'lookup', name: 'scratch', cwd: join(nested, 'sub') }))
        .toMatchObject({ status: 'untrusted', projectRoot: nested, run: 'echo nested' });
      expect(await host.handle({ op: 'list', cwd: join(nested, 'sub'), global: false }))
        .toMatchObject({ listing: { project: { path: join(nested, 'dormouse.yml'), approved: false } } });
    });
  });

  describe('list', () => {
    const PROJECT = `tools:
  # The component catalog.
  storybook:
    run: pnpm storybook
    port: auto
    prespawn_dedupe: [storybook, $HERE]
  harness:
    run: [pnpm, harness, $ARGS]
    render: agent-browser-screencast
    colour: blue
`;
    const USER = `tools:
  # Mine, hidden here by the project's.
  storybook:
    run: npx storybook
  # Render Markdown.
  md:
    run: [glow, $TARGET]
`;

    it('lists project then user Tools with comments, approval, and shadowing, running nothing', async () => {
      await writeFile(join(repo, 'dormouse.yml'), PROJECT);
      const userConfigPath = userFile('user.yml');
      await writeFile(userConfigPath, USER);
      const host = createToolHost({ stateDir, userConfigPath });
      const before = await host.handle({ op: 'list', cwd: join(repo), global: false });
      expect(before).toEqual({ status: 'list', listing: {
        project: { path: join(repo, 'dormouse.yml'), approved: false },
        user: { path: userConfigPath, found: true },
        tools: [
          { name: 'storybook', scope: 'project', run: 'pnpm storybook', render: 'iframe', port: 'auto', keyed: true, description: 'The component catalog.', shadowed: false },
          { name: 'harness', scope: 'project', run: ['pnpm', 'harness', '$ARGS'], render: 'agent-browser-screencast', port: 'announced', keyed: false, description: null, shadowed: false },
          { name: 'storybook', scope: 'user', run: 'npx storybook', render: 'iframe', port: 'announced', keyed: false, description: "Mine, hidden here by the project's.", shadowed: true },
          { name: 'md', scope: 'user', run: ['glow', '$TARGET'], render: 'iframe', port: 'announced', keyed: false, description: 'Render Markdown.', shadowed: false },
        ],
        warnings: [`${join(repo, 'dormouse.yml')}: tools.harness: ignoring unknown field 'colour'`],
      } });
      await host.handle({ op: 'trust', kind: 'folder', projectRoot: repo });
      expect(await host.handle({ op: 'list', cwd: repo, global: false })).toMatchObject({ listing: { project: { approved: true } } });
    });

    it('--global lists only user Tools, none shadowed', async () => {
      await writeFile(join(repo, 'dormouse.yml'), PROJECT);
      const userConfigPath = userFile('user.yml');
      await writeFile(userConfigPath, USER);
      const result = await createToolHost({ userConfigPath }).handle({ op: 'list', cwd: repo, global: true });
      expect(result).toMatchObject({ status: 'list', listing: { project: null, warnings: [] } });
      expect(result.status === 'list' && result.listing.tools.map(tool => [tool.name, tool.scope, tool.shadowed])).toEqual([
        ['storybook', 'user', false], ['md', 'user', false],
      ]);
    });

    it('answers an empty listing when neither file exists', async () => {
      await rm(join(repo, 'dormouse.yml'));
      const userConfigPath = userFile('missing-user.yml');
      expect(await createToolHost({ userConfigPath }).handle({ op: 'list', cwd: repo, global: false })).toEqual({ status: 'list', listing: {
        project: null, user: { path: userConfigPath, found: false }, tools: [], warnings: [],
      } });
    });

    it('fails on a malformed file, as lookup does', async () => {
      await writeFile(join(repo, 'dormouse.yml'), 'tools:\n  broken:\n    render: iframe\n');
      expect(await createToolHost({ userConfigPath: userFile('missing-user.yml') }).handle({ op: 'list', cwd: repo, global: false }))
        .toMatchObject({ status: 'error', message: expect.stringContaining("'run' is required") });
    });
  });

  describe('imports', () => {
    // The user file and the clones kept beside it, as git submodules would be.
    let config = '';
    let userPath = '';
    let clone = '';
    let supertools = '';
    const PRIDM = `tools:
  # The clone's own words.
  pridm:
    run: [node, $HERE/main.js, $CWD]
    prespawn_dedupe: [pridm, $HERE]
    colour: blue
  # Not imported.
  other:
    run: other
    shade: red
open:
  - {match: '*', tool: other}
browser:
  default_viewport: nonsense
`;
    const USER_IMPORTS = (supertoolsDir: string) => `tools:
  # PR dashboard, in my words.
  pridm:
    from: pridm
  prs:
    from: ${supertoolsDir}
    tool: pr-dashboard
  scratch:
    run: echo hi
`;
    const write = async (path: string, text: string) => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text);
    };

    beforeEach(async () => {
      config = join(repo, 'config');
      userPath = join(config, 'dormouse.yml');
      clone = join(config, 'pridm');
      supertools = join(repo, 'elsewhere', 'supertools');
      await write(join(clone, 'dormouse.yml'), PRIDM);
      await write(join(supertools, 'dormouse.yml'), 'tools:\n  # Review PRs.\n  pr-dashboard:\n    run: [dash, $ARGS]\n');
      await write(userPath, USER_IMPORTS(supertools));
    });

    it('resolves a relative import as a user Tool whose $HERE is the imported directory, needing no grant', async () => {
      const cwd = join(repo, 'work');
      await mkdir(cwd);
      // `repo` holds a project file without `pridm`, so this is the user fallback.
      expect(await createToolHost({ stateDir, userConfigPath: userPath }).handle({ op: 'lookup', name: 'pridm', cwd })).toEqual({
        status: 'ok', scope: 'user', name: 'pridm', path: join(clone, 'dormouse.yml'), projectRoot: clone,
        run: ['node', join(clone, 'main.js'), cwd], key: ['pridm', clone], render: 'iframe', port: 'announced',
        viewport: { mode: 'pane-sync' },
        warnings: [`${join(clone, 'dormouse.yml')}: tools.pridm: ignoring unknown field 'colour'`],
      });
    });

    it('resolves an absolute import under its local name, and a tool: rename', async () => {
      expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'prs', cwd: repo, global: true, args: ['--all'] }))
        .toMatchObject({ status: 'ok', scope: 'user', name: 'prs', path: join(supertools, 'dormouse.yml'), projectRoot: supertools, run: ['dash', '--all'] });
      expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'pr-dashboard', cwd: repo, global: true }))
        .toMatchObject({ status: 'unknown-tool', names: ['pridm', 'prs', 'scratch'] });
    });

    it.skipIf(process.platform === 'win32')('follows a symlinked directory to the import, keying it on the real one', async () => {
      await symlink(clone, join(config, 'pridm-link'));
      await writeFile(userPath, 'tools:\n  pridm:\n    from: pridm-link\n');
      expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'pridm', cwd: repo, global: true }))
        .toMatchObject({ status: 'ok', path: join(clone, 'dormouse.yml'), key: ['pridm', clone] });
    });

    it('carries no checkout warning for an imported key without $HERE: an import has one clone', async () => {
      await writeFile(join(supertools, 'dormouse.yml'), 'tools:\n  pr-dashboard:\n    run: [dash]\n    prespawn_dedupe: dash\n');
      expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'prs', cwd: repo, global: true }))
        .toMatchObject({ status: 'ok', key: ['dash'], warnings: [`${join(clone, 'dormouse.yml')}: tools.pridm: ignoring unknown field 'colour'`] });
    });

    it('lists an import with the file it came from and the local comment over the imported one', async () => {
      const result = await createToolHost({ userConfigPath: userPath }).handle({ op: 'list', cwd: repo, global: true });
      expect(result).toEqual({ status: 'list', listing: {
        project: null,
        user: { path: userPath, found: true },
        tools: [
          { name: 'pridm', scope: 'user', run: ['node', '$HERE/main.js', '$CWD'], render: 'iframe', port: 'announced', keyed: true,
            description: 'PR dashboard, in my words.', shadowed: false, from: join(clone, 'dormouse.yml') },
          { name: 'prs', scope: 'user', run: ['dash', '$ARGS'], render: 'iframe', port: 'announced', keyed: false,
            description: 'Review PRs.', shadowed: false, from: join(supertools, 'dormouse.yml') },
          { name: 'scratch', scope: 'user', run: 'echo hi', render: 'iframe', port: 'announced', keyed: false, description: null, shadowed: false },
        ],
        warnings: [`${join(clone, 'dormouse.yml')}: tools.pridm: ignoring unknown field 'colour'`],
      } });
    });

    it('still finds the clone\'s own file as an unapproved project file from inside it', async () => {
      expect(await createToolHost({ stateDir, userConfigPath: userPath }).handle({ op: 'lookup', name: 'pridm', cwd: clone }))
        .toMatchObject({ status: 'untrusted', path: join(clone, 'dormouse.yml'), projectRoot: clone });
      expect(await createToolHost({ stateDir, userConfigPath: userPath }).handle({ op: 'list', cwd: clone, global: false }))
        .toMatchObject({ listing: { project: { path: join(clone, 'dormouse.yml'), approved: false } } });
    });

    describe('a broken import fails only itself', () => {
      const BROKEN = {
        nodir: ['from: missing', 'missing/dormouse.yml', ': not found'],
        nofile: ['from: empty', 'empty/dormouse.yml', ': not found'],
        malformed: ['from: malformed', 'malformed/dormouse.yml', ": tools.malformed: 'run' is required and must be a non-empty string or argument list"],
        noentry: ['from: pridm\n    tool: absent', 'pridm/dormouse.yml', ": no Tool 'absent' (declares: pridm, other)"],
        chained: ['from: chained', 'chained/dormouse.yml', ": tools.chained: 'from' imports a Tool only in the user file"],
      } as const;

      beforeEach(async () => {
        await mkdir(join(config, 'empty'));
        await write(join(config, 'malformed', 'dormouse.yml'), 'tools:\n  malformed:\n    render: iframe\n');
        await write(join(config, 'chained', 'dormouse.yml'), 'tools:\n  chained:\n    from: ../pridm\n');
        await writeFile(userPath, `${USER_IMPORTS(supertools)}${Object.entries(BROKEN).map(([name, [entry]]) => `  # Why ${name}.\n  ${name}:\n    ${entry}\n`).join('')}`
          + 'browser:\n  viewports:\n    custom: { width: 1100, height: 800 }\n');
      });

      it.each(Object.entries(BROKEN))('%s: its lookup names both files and why', async (name, [, file, reason]) => {
        expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name, cwd: repo, global: true })).toEqual({
          status: 'error', message: `${userPath}: tools.${name} imports '${name === 'noentry' ? 'absent' : name}': ${join(config, file)}${reason}`,
        });
      });

      it('leaves every other Tool, the listing, and browser settings working', async () => {
        const host = createToolHost({ userConfigPath: userPath });
        expect(await host.handle({ op: 'lookup', name: 'scratch', cwd: repo, global: true })).toMatchObject({ status: 'ok', run: 'echo hi' });
        expect(await host.handle({ op: 'lookup', name: 'pridm', cwd: repo, global: true })).toMatchObject({ status: 'ok' });
        expect(await host.handle({ op: 'browser-config', cwd: repo })).toMatchObject({ status: 'browser-config', config: { viewports: { custom: { width: 1100 } } } });
        const result = await host.handle({ op: 'list', cwd: repo, global: true });
        expect(result.status === 'list' && result.listing.tools.map(tool => tool.name)).toEqual(['pridm', 'prs', 'scratch', ...Object.keys(BROKEN)]);
        expect(result.status === 'list' && result.listing.tools.find(tool => tool.name === 'nodir')).toEqual({
          name: 'nodir', scope: 'user', description: 'Why nodir.', shadowed: false,
          from: join(config, 'missing', 'dormouse.yml'), broken: `${join(config, 'missing', 'dormouse.yml')}: not found`,
        });
      });

      it('lists a broken import among the names an unknown lookup reports', async () => {
        expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'nope', cwd: repo, global: true }))
          .toMatchObject({ status: 'unknown-tool', names: ['chained', 'malformed', 'nodir', 'noentry', 'nofile', 'pridm', 'prs', 'scratch'] });
      });

      it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable imported file', async () => {
        await chmod(join(config, 'malformed', 'dormouse.yml'), 0);
        expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'malformed', cwd: repo, global: true })).toEqual({
          status: 'error', message: `${userPath}: tools.malformed imports 'malformed': ${join(config, 'malformed', 'dormouse.yml')}: cannot read (EACCES)`,
        });
      });

      it.skipIf(process.platform === 'win32')('refuses a symlinked imported file', async () => {
        await mkdir(join(config, 'linked'));
        await symlink(join(clone, 'dormouse.yml'), join(config, 'linked', 'dormouse.yml'));
        await writeFile(userPath, 'tools:\n  pridm:\n    from: linked\n');
        expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'pridm', cwd: repo, global: true })).toEqual({
          status: 'error', message: `${userPath}: tools.pridm imports 'pridm': ${join(config, 'linked', 'dormouse.yml')}: tool file must be a regular file, not a symbolic link`,
        });
      });

      it.skipIf(process.platform === 'win32')('refuses a directory that is a link to a share', async () => {
        await symlink('//fileserver/share', join(config, 'share'));
        await writeFile(userPath, 'tools:\n  pridm:\n    from: share\n');
        expect(await createToolHost({ userConfigPath: userPath }).handle({ op: 'lookup', name: 'pridm', cwd: repo, global: true }))
          .toMatchObject({ status: 'error', message: expect.stringContaining('not a folder on this machine') });
      });
    });
  });
});
