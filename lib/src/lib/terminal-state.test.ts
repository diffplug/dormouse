import { describe, expect, it } from 'vitest';
import { POSIX_ESCAPABLE } from './posix-escape';
import { shellEscapePosix } from './shell-escape';
import {
  commandArgv0,
  createTerminalPaneState,
  cwdDisplay,
  cwdFromManualPath,
  cwdFromOsc7,
  cwdFromOsc9_9,
  cwdIdentity,
  COMMAND_FAIL_GLYPH,
  DEFAULT_IDLE_TITLE,
  deriveHeader,
  deriveSurfaceLabel,
  buildAppTitleResolver,
  groupTerminalPanes,
  notificationDisplayTitle,
  reduceTerminalState,
  shortestUniqueCwdLabels,
  summarizeCommandLine,
  surfaceRunsCommand,
  terminalTitleFromNotification,
  titleCandidatesForDisplay,
  type CwdState,
} from './terminal-state';

describe('terminal CWD normalization', () => {
  it('parses OSC 7 file URIs with host identity and decoded paths', () => {
    expect(cwdFromOsc7('file://prod-box/home/me/with%20space', 100)).toEqual({
      uri: 'file://prod-box/home/me/with%20space',
      path: '/home/me/with space',
      host: 'prod-box',
      scheme: 'file',
      pathKind: 'posix',
      isRemote: true,
      source: 'osc7',
      updatedAt: 100,
    });

    expect(cwdFromOsc7('file://localhost/C:/Users/me/project', 100)).toEqual({
      uri: 'file://localhost/C:/Users/me/project',
      path: 'C:/Users/me/project',
      host: 'localhost',
      scheme: 'file',
      pathKind: 'windows',
      isRemote: false,
      source: 'osc7',
      updatedAt: 100,
    });
  });

  it('marks OSC 9;9 Windows paths and leaves other paths unknown', () => {
    expect(cwdFromOsc9_9('C:\\repo', 100)?.pathKind).toBe('windows');
    expect(cwdFromOsc9_9('\\\\server\\share\\repo', 100)).toMatchObject({
      pathKind: 'windows',
      isRemote: true,
    });
    expect(cwdFromOsc9_9('/mnt/c/repo', 100)).toMatchObject({
      pathKind: 'unknown',
      isRemote: false,
    });
  });

  it('builds shortest unique labels without losing remote hosts', () => {
    const local = cwd('/Users/me/app', 'localhost');
    const remote = cwd('/Users/me/app', 'prod-box');
    const sibling = cwd('/Users/me/other/app', 'localhost');
    const labels = shortestUniqueCwdLabels([local, remote, sibling]);

    expect(labels.get(cwdIdentity(local))).toBe('localhost:me/app');
    expect(labels.get(cwdIdentity(remote))).toBe('prod-box:me/app');
    expect(labels.get(cwdIdentity(sibling))).toBe('other/app');
    expect(cwdDisplay(remote)).toBe('prod-box:me/app');
  });

  it('does not duplicate UNC roots in full-depth labels', () => {
    const share = cwdFromOsc9_9('\\\\server\\share\\repo\\app', 100)!;
    const otherShare = cwdFromOsc9_9('\\\\server\\other\\repo\\app', 100)!;
    const labels = shortestUniqueCwdLabels([share, otherShare]);

    expect(cwdDisplay(share, { maxSegments: 2 })).toBe('\\\\server\\share\\repo\\app');
    expect(labels.get(cwdIdentity(share))).toBe('\\\\server\\share\\repo\\app');
    expect(labels.get(cwdIdentity(otherShare))).toBe('\\\\server\\other\\repo\\app');
  });
});

describe('terminal command state reducer', () => {
  it('tracks full OSC 633 lifecycle with command CWD snapshot', () => {
    const startCwd = cwdFromManualPath('/repo/app', 10)!;
    let state = createTerminalPaneState({ cwd: startCwd });

    state = reduceTerminalState(state, { type: 'promptStart' });
    state = reduceTerminalState(state, { type: 'promptEnd' });
    state = reduceTerminalState(state, { type: 'commandLine', commandLine: 'pnpm test --watch' });
    state = reduceTerminalState(state, { type: 'commandStart', source: 'osc633_boundaries' }, {
      now: () => 20,
      createId: () => 'cmd-1',
    });

    expect(state.activity).toEqual({ kind: 'running' });
    expect(state.pendingCommandLine).toBeNull();
    expect(state.currentCommand).toMatchObject({
      id: 'cmd-1',
      rawCommandLine: 'pnpm test --watch',
      displayCommand: 'pnpm test --watch',
      cwdAtStart: startCwd,
      startedAt: 20,
      source: 'osc633_E',
    });

    state = reduceTerminalState(state, { type: 'cwd', cwd: cwdFromManualPath('/repo/other', 30)! });
    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 1 }, { now: () => 40 });

    expect(state.activity).toEqual({ kind: 'finished', exitCode: 1 });
    expect(state.currentCommand).toBeNull();
    expect(state.lastCommand).toMatchObject({
      displayCommand: 'pnpm test --watch',
      cwdAtStart: startCwd,
      finishedAt: 40,
      exitCode: 1,
    });
  });

  it('handles OSC 133 lifecycle without command line and finish without current command', () => {
    let state = createTerminalPaneState({ title: { title: 'zsh', source: 'osc0', updatedAt: 1 } });
    state = reduceTerminalState(state, { type: 'commandStart', source: 'osc133_boundaries' }, {
      now: () => 2,
      createId: () => 'cmd-2',
    });

    expect(state.currentCommand).toMatchObject({
      displayCommand: 'zsh',
      source: 'osc133_boundaries',
    });

    state = reduceTerminalState(state, { type: 'commandFinish' });
    expect(state.activity).toEqual({ kind: 'finished' });

    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 0 });
    expect(state.activity).toEqual({ kind: 'finished', exitCode: 0 });

    state = reduceTerminalState(state, { type: 'promptStart' });
    expect(state.activity).toEqual({ kind: 'prompt' });
  });

  it('stores latest title candidates by source channel', () => {
    let state = createTerminalPaneState();
    state = reduceTerminalState(state, { type: 'title', title: { title: 'zsh', source: 'osc0', updatedAt: 1 } });
    state = reduceTerminalState(state, { type: 'title', title: { title: 'vim', source: 'osc2', updatedAt: 2 } });
    state = reduceTerminalState(state, { type: 'title', title: { title: 'dormouse', source: 'osc0', updatedAt: 3 } });

    expect(state.title).toEqual({ title: 'dormouse', source: 'osc0', updatedAt: 3 });
    expect(state.titleCandidates.osc0).toEqual({ title: 'dormouse', source: 'osc0', updatedAt: 3 });
    expect(state.titleCandidates.osc2).toEqual({ title: 'vim', source: 'osc2', updatedAt: 2 });
    expect(titleCandidatesForDisplay(state).map((candidate) => [candidate.source, candidate.title])).toEqual([
      ['osc0', 'dormouse'],
      ['osc2', 'vim'],
    ]);
  });

  it('uses a pending typed command line for OSC 133 command boundaries', () => {
    let state = createTerminalPaneState({ cwd: cwdFromManualPath('/repo/app', 1)! });
    state = reduceTerminalState(state, { type: 'promptEnd' });
    state = reduceTerminalState(state, { type: 'commandLine', commandLine: 'lazygit' });
    state = reduceTerminalState(state, { type: 'commandStart', source: 'osc133_boundaries' }, {
      now: () => 2,
      createId: () => 'cmd-typed',
    });

    expect(state.currentCommand).toMatchObject({
      id: 'cmd-typed',
      rawCommandLine: 'lazygit',
      displayCommand: 'lazygit',
      source: 'osc133_boundaries',
    });

    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 0 }, { now: () => 3 });
    expect(state.activity).toEqual({ kind: 'finished', exitCode: 0 });
    expect(deriveHeader(state, [state])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} lazygit`,
    });

    state = reduceTerminalState(state, { type: 'promptStart' });
    expect(deriveHeader(state, [state])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} lazygit`,
    });
  });

  it('appends the fail glyph to the idle title when the last command exited non-zero', () => {
    let state = runningPane('/repo/app', 'pnpm build');
    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 1 }, { now: () => 2 });

    expect(deriveHeader(state, [state])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} pnpm build ${COMMAND_FAIL_GLYPH}`,
      lastCommandFailed: true,
    });

    // The marker persists across the next prompt, until a new command runs.
    state = reduceTerminalState(state, { type: 'promptStart' });
    expect(deriveHeader(state, [state]).primary).toBe(`${DEFAULT_IDLE_TITLE} pnpm build ${COMMAND_FAIL_GLYPH}`);
  });

  it('shows no fail glyph for a successful command', () => {
    let state = runningPane('/repo/app', 'pnpm build');
    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 0 }, { now: () => 2 });

    expect(deriveHeader(state, [state])).toEqual({ primary: `${DEFAULT_IDLE_TITLE} pnpm build` });
  });

  it('shows no fail glyph when the exit code is unknown (keystroke fallback)', () => {
    let state = runningPane('/repo/app', 'pnpm build');
    state = reduceTerminalState(state, { type: 'commandFinish' }, { now: () => 2 });

    expect(deriveHeader(state, [state])).toEqual({ primary: `${DEFAULT_IDLE_TITLE} pnpm build` });
  });

  it('drops the fail glyph once a new command starts running', () => {
    let state = runningPane('/repo/app', 'pnpm build');
    state = reduceTerminalState(state, { type: 'commandFinish', exitCode: 1 }, { now: () => 2 });
    state = reduceTerminalState(state, { type: 'commandStart', source: 'osc633_boundaries' }, {
      now: () => 3,
      createId: () => 'next',
    });

    // While running we show the live command, no glyph.
    expect(deriveHeader(state, [state]).primary).not.toContain(COMMAND_FAIL_GLYPH);
  });

  it('clears stale pending typed command lines on a fresh prompt', () => {
    let state = createTerminalPaneState({ pendingCommandLine: 'stale command' });

    state = reduceTerminalState(state, { type: 'promptStart' });
    expect(state.pendingCommandLine).toBeNull();

    state = reduceTerminalState({ ...state, pendingCommandLine: 'another stale command' }, { type: 'promptEnd' });
    expect(state.pendingCommandLine).toBeNull();
  });

  it('moves an unclosed command back to idle when the next prompt starts', () => {
    const cwd = cwdFromManualPath('/repo/app', 1)!;
    let state = createTerminalPaneState({ cwd });
    state = reduceTerminalState(state, { type: 'commandLine', commandLine: 'lazygit' });
    state = reduceTerminalState(state, { type: 'commandStart', source: 'user_input' }, {
      now: () => 2,
      createId: () => 'cmd-user-input',
    });

    expect(deriveHeader(state, [state])).toEqual({
      primary: 'lazygit',
    });

    state = reduceTerminalState(state, { type: 'promptStart' });

    expect(state.currentCommand).toBeNull();
    expect(deriveHeader(state, [state])).toEqual({
      primary: DEFAULT_IDLE_TITLE,
    });
  });
});

describe('command title summarizer', () => {
  it('summarizes common commands compactly', () => {
    expect(summarizeCommandLine('npm run dev')).toBe('npm run dev');
    expect(summarizeCommandLine('FOO=1 pnpm test --watch --reporter verbose')).toBe('pnpm test --watch');
    expect(summarizeCommandLine('docker compose up --build')).toBe('docker compose up');
    expect(summarizeCommandLine('cargo watch -x test')).toBe('cargo watch -x test');
    expect(summarizeCommandLine('pytest tests/unit -q')).toBe('pytest');
    expect(summarizeCommandLine('ssh prod-box')).toBe('ssh prod-box');
  });

  // One name per program: the launcher suffix is dropped everywhere, so the
  // header reads the same name as the WATCHING rule row and the bell tooltip.
  it('reads a Windows launcher as the program it launches', () => {
    expect(summarizeCommandLine('vim.exe notes.txt')).toBe('vim');
    expect(summarizeCommandLine('cargo.exe watch -x test')).toBe('cargo watch -x test');
    expect(summarizeCommandLine('C:\\tools\\nodejs\\npm.cmd')).toBe('npm');
    expect(summarizeCommandLine('C:\\tools\\nodejs\\npm.cmd run dev')).toBe('npm run dev');
  });

  it('keeps pipelines and compound commands recognizable', () => {
    expect(summarizeCommandLine('cat package.json | jq .name')).toBe('cat package.json | ...');
    expect(summarizeCommandLine('cd lib && pnpm test')).toBe('cd lib ...');
    expect(summarizeCommandLine('"my command" "quoted arg"')).toBe('my command quoted arg');
  });
});

describe('command tokenizer dialects', () => {
  // A backslash is a path separator unless it precedes something a shell really
  // escapes, so both dialects reduce to the bare program name.
  it.each([
    // Windows: absolute paths, launchers, a quoted path with spaces.
    ['C:\\tools\\dor.cmd tool storybook', 'dor', 'dor tool storybook'],
    ['C:\\Users\\me\\.claude\\local\\claude', 'claude', 'claude'],
    ['"C:\\Program Files\\nodejs\\npm.cmd" run dev', 'npm', 'npm run dev'],
    ['\\\\build\\share\\tools\\claude.exe --print', 'claude', 'claude --print'],
    ['FOO=1 "C:\\Program Files\\nodejs\\npm.cmd" run dev', 'npm', 'npm run dev'],
    // PowerShell's call operator, the only way that shell runs a quoted path.
    // Without the leading-`&` skip it reads as a boundary and argv0 is null.
    ['& "C:\\Program Files\\nodejs\\npm.cmd" run dev', 'npm', 'npm run dev'],
    ['& C:\\tools\\dor.cmd tool storybook', 'dor', 'dor tool storybook'],
    // POSIX escapes keep their meaning.
    ['/opt/my\\ tools/claude --print', 'claude', 'claude --print'],
    ['grep \\*.ts src', 'grep', 'grep *.ts src'],
    ['echo a\\\\b', 'echo', 'echo a\\b'],
  ])('reduces %j to %j / %j', (raw, argv0, summary) => {
    expect(commandArgv0(raw)).toBe(argv0);
    expect(summarizeCommandLine(raw)).toBe(summary);
  });

  // An unquoted Windows path with spaces is undecidable without probing the
  // filesystem — `A\B C\D.cmd` is equally `A\B` plus an argument — so the
  // tokenizer splits it and argv0 misses rather than naming the wrong program.
  it('leaves an unquoted Windows path with spaces split', () => {
    expect(commandArgv0('C:\\Program Files\\nodejs\\npm.cmd run dev')).toBe('Program');
    expect(commandArgv0('"C:\\Program Files\\Git\\bin\\bash" scripts\\bootstrap.cmd')).toBe('bash');
  });

  it('pins the ordinary POSIX argv[0] escape cost of dialect-free tokenizing', () => {
    expect(commandArgv0('foo\\-bar')).toBe('-bar');
  });

  // `POSIX_ESCAPABLE` is `shellEscapePosix`'s set; the tokenizer unescapes it.
  // The two halves must name the same characters or a path Dormouse escaped for
  // a drag-and-drop paste renders with stray backslashes in the pane header.
  const ESCAPABLE = ` \t!"#$&'()*;<>?[]\`{|}~\\`;

  it('is exactly the set spelled out here, so a change to it lands in this file', () => {
    // Both directions, so neither a new nor a dropped member slips through.
    expect(Array.from(ESCAPABLE).filter((char) => !POSIX_ESCAPABLE.test(char))).toEqual([]);
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    expect(printable.filter((char) => POSIX_ESCAPABLE.test(char)).join('')).toBe(
      Array.from(ESCAPABLE).filter((char) => char !== '\t').sort().join(''),
    );
  });

  it.each(Array.from(ESCAPABLE))('round-trips %j out of shellEscapePosix', (char) => {
    expect(summarizeCommandLine(`cat ${shellEscapePosix(`a${char}b`)}`)).toBe(`cat a${char}b`);
  });
});

describe('header and grouping derivation', () => {
  it('uses <idle> for terminals without a foreground command', () => {
    const pane = createTerminalPaneState({ cwd: cwdFromManualPath('/repo/app', 1)!, activity: { kind: 'editing' } });

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: DEFAULT_IDLE_TITLE,
    });
  });

  it('uses command start CWD for running headers and disambiguates duplicates', () => {
    const app = runningPane('/repo/app', 'pnpm test --watch');
    const api = runningPane('/repo/api', 'pnpm test --watch');

    expect(deriveHeader(app, [app, api])).toEqual({
      primary: 'pnpm test --watch',
      secondary: 'app',
    });
    expect(deriveHeader(api, [app, api])).toEqual({
      primary: 'pnpm test --watch',
      secondary: 'api',
    });
  });

  it('deriveSurfaceLabel composes deriveHeader + resolveDisplayPrimary for one pane', () => {
    // A real command label wins; the fallback title is ignored.
    const running = runningPane('/repo/app', 'pnpm test --watch');
    expect(deriveSurfaceLabel(running, [running], () => null, 'door title')).toBe('pnpm test --watch');
    // An idle pane stays <idle> (resolveDisplayPrimary substitutes the fallback
    // only for the generic command title, not for idle).
    const idle = createTerminalPaneState();
    expect(deriveSurfaceLabel(idle, [idle], () => null, 'door title')).toBe(DEFAULT_IDLE_TITLE);
  });

  it('lets fresh app-sent terminal titles override running command labels', () => {
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'lazygit'),
      { type: 'title', title: { title: 'lazygit: dormouse', source: 'osc0', updatedAt: 2 } },
    );

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'lazygit: dormouse',
    });
  });

  it('keeps the command when ConPTY broadcasts a child process path as the title', () => {
    // pnpm's script shell on Windows is cmd.exe, whose console title (its own
    // image path) ConPTY relays as OSC 0 — no command meaning, so the detected
    // command must stand.
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'pnpm dev:website'),
      { type: 'title', title: { title: 'C:\\WINDOWS\\system32\\cmd.exe', source: 'osc0', updatedAt: 2 } },
    );

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'pnpm dev:website',
    });
  });

  it('strips cmd.exe\'s interpreter prefix, leaving the command', () => {
    // cmd.exe sets its console title to "<path>\cmd.exe - <command>"; show the command.
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'pnpm dev:website'),
      { type: 'title', title: { title: 'C:\\WINDOWS\\system32\\cmd.exe - pnpm dev:website', source: 'osc0', updatedAt: 2 } },
    );

    expect(deriveHeader(pane, [pane])).toEqual({ primary: 'pnpm dev:website' });
  });

  it('keeps the command when the title is a bare shell name', () => {
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'pnpm dev:website'),
      { type: 'title', title: { title: 'pwsh', source: 'osc0', updatedAt: 2 } },
    );

    expect(deriveHeader(pane, [pane])).toEqual({ primary: 'pnpm dev:website' });
  });

  it('ignores stale shell titles from before a command started', () => {
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'lazygit'),
      { type: 'title', title: { title: 'zsh', source: 'osc0', updatedAt: 0 } },
    );

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'lazygit',
    });
  });

  it('keeps user-pinned titles primary when newer app title candidates arrive', () => {
    let pane = runningPane('/repo/app', 'npm run dev');
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'dev server', source: 'user', updatedAt: 2 } });
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'vite', source: 'osc0', updatedAt: 3 } });

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'dev server',
    });
    expect(titleCandidatesForDisplay(pane).map((candidate) => candidate.source)).toEqual(['osc0', 'user']);
  });

  it('lets legacy OSC 9 message text override derived command labels', () => {
    const pane = runningPane('/repo/app', 'npm run build');
    const terminalStates = new Map([['pane', pane]]);
    const activityStates = new Map([
      ['pane', { notification: { source: 'OSC 9', title: null, body: 'Build finished' } }],
    ]);

    expect(notificationDisplayTitle(activityStates.get('pane')?.notification)).toBe('Build finished');
    expect(deriveHeader(pane, [pane], {
      appTitleForPane: buildAppTitleResolver(terminalStates, activityStates),
    })).toEqual({
      primary: 'Build finished',
    });
  });

  it('ignores stale OSC 9 notifications emitted before the current command', () => {
    const pane = reduceTerminalState(
      runningPane('/repo/app', 'npm run build'),
      { type: 'title', title: { title: 'Build finished', source: 'osc9', updatedAt: 0 } },
    );
    const terminalStates = new Map([['pane', pane]]);
    const activityStates = new Map([
      ['pane', { notification: { source: 'OSC 9', title: null, body: 'Build finished' } }],
    ]);

    expect(deriveHeader(pane, [pane], {
      appTitleForPane: buildAppTitleResolver(terminalStates, activityStates),
    })).toEqual({
      primary: 'npm run build',
    });
  });

  it('does not use rich notification titles as tab title overrides', () => {
    expect(notificationDisplayTitle({ source: 'OSC 777', title: 'Tests', body: '341 passed' })).toBeNull();
    expect(notificationDisplayTitle({ source: 'OSC 99', title: 'Build', body: 'Finished successfully' })).toBeNull();
    expect(terminalTitleFromNotification({ source: 'OSC 777', title: 'Tests', body: '341 passed' }, 2)).toEqual({
      title: 'Tests',
      source: 'osc777',
      updatedAt: 2,
    });
    expect(terminalTitleFromNotification({ source: 'OSC 99', title: 'Build', body: 'Finished successfully' }, 3)).toEqual({
      title: 'Build',
      source: 'osc99',
      updatedAt: 3,
    });

    const pane = reduceTerminalState(
      runningPane('/repo/app', 'npm test'),
      { type: 'title', title: { title: 'Tests', source: 'osc777', updatedAt: 3 } },
    );
    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'npm test',
    });
  });

  it('shows `<idle> ${displayCommand}` after a command finishes', () => {
    const running = runningPane('/repo/app', 'npm run build');
    const finished = reduceTerminalState(running, { type: 'commandFinish', exitCode: 0 }, { now: () => 2 });

    expect(finished.lastCommand?.displayCommand).toBe('npm run build');
    expect(deriveHeader(finished, [finished])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} npm run build`,
    });

    const afterPrompt = reduceTerminalState(finished, { type: 'promptStart' });
    expect(deriveHeader(afterPrompt, [afterPrompt])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} npm run build`,
    });
  });

  it('uses the in-run app-sent title as `<idle> ${LAST_TITLE}`', () => {
    let pane = runningPane('/repo/app', 'lazygit');
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'lazygit: dormouse', source: 'osc0', updatedAt: 2 } });
    pane = reduceTerminalState(pane, { type: 'commandFinish', exitCode: 0 }, { now: () => 3 });

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} lazygit: dormouse`,
    });
  });

  it('ignores titles emitted after the last command finished when deriving LAST_TITLE', () => {
    let pane = runningPane('/repo/app', 'lazygit');
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'lazygit: dormouse', source: 'osc0', updatedAt: 2 } });
    pane = reduceTerminalState(pane, { type: 'commandFinish', exitCode: 0 }, { now: () => 3 });
    // Shell sets the title back to its default after the command exits.
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'zsh', source: 'osc0', updatedAt: 4 } });

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: `${DEFAULT_IDLE_TITLE} lazygit: dormouse`,
    });
  });

  it('keeps a user-pinned title primary even after a command finishes', () => {
    let pane = runningPane('/repo/app', 'npm run build');
    pane = reduceTerminalState(pane, { type: 'title', title: { title: 'build pane', source: 'user', updatedAt: 2 } });
    pane = reduceTerminalState(pane, { type: 'commandFinish', exitCode: 0 }, { now: () => 3 });

    expect(deriveHeader(pane, [pane])).toEqual({
      primary: 'build pane',
    });
  });

  it('preserves remote identity when two panes have the same path', () => {
    const local = runningPane('/home/me/app', 'npm run dev', 'localhost');
    const remote = runningPane('/home/me/app', 'npm run dev', 'prod-box');

    expect(deriveHeader(local, [local, remote]).secondary).toBe('localhost:app');
    expect(deriveHeader(remote, [local, remote]).secondary).toBe('prod-box:app');
  });

  it('groups by directory, command, and status', () => {
    const running = runningPane('/repo/app', 'npm run dev');
    const idle = createTerminalPaneState({ cwd: cwdFromManualPath('/repo/api', 1)! });
    const finished = reduceTerminalState(running, { type: 'commandFinish', exitCode: 0 }, { now: () => 2 });

    expect(groupTerminalPanes([running, idle], 'directory').map((group) => group.label)).toEqual(['app', 'api']);
    expect(groupTerminalPanes([running, idle], 'command').map((group) => group.label)).toEqual(['npm run dev', DEFAULT_IDLE_TITLE]);
    expect(groupTerminalPanes([running, idle, finished], 'status').map((group) => group.key)).toEqual([
      'running',
      'unknown',
      'finished',
    ]);
  });
});

describe('surfaceRunsCommand (dor ensure matching)', () => {
  it('matches a pane currently running the exact command in the same cwd', () => {
    const pane = runningPane('/repo/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/app')).toBe(true);
  });

  it('is exact: a different command line does not match', () => {
    const pane = runningPane('/repo/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(pane, 'pnpm dev:website --host', '/repo/app')).toBe(false);
    expect(surfaceRunsCommand(pane, 'pnpm dev', '/repo/app')).toBe(false);
  });

  it('does not match the same command in a different working directory', () => {
    const pane = runningPane('/repo/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/other')).toBe(false);
  });

  it('only matches while the command is live', () => {
    let pane = runningPane('/repo/app', 'pnpm dev:website');
    pane = reduceTerminalState(pane, { type: 'commandFinish', exitCode: 0 });
    expect(pane.currentCommand).toBeNull();
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/app')).toBe(false);
  });

  it('never matches a pane with no reported command line (no shell integration)', () => {
    const pane = createTerminalPaneState({
      cwd: cwd('/repo/app'),
      activity: { kind: 'running' },
      currentCommand: {
        id: 'run-x',
        rawCommandLine: null,
        displayCommand: 'shell',
        cwdAtStart: cwd('/repo/app'),
        startedAt: 1,
        source: 'osc133_boundaries',
      },
    });
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/app')).toBe(false);
  });

  it('compares the cwd exactly (the CLI sends a canonicalized path)', () => {
    const pane = runningPane('/repo/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/app')).toBe(true);
    expect(surfaceRunsCommand(pane, 'pnpm dev:website', '/repo/app/')).toBe(false);
  });

  it('matches across the Windows/Git-Bash cwd dialect split', () => {
    // Git Bash reports its cwd as POSIX (`/c/Users/...`) via OSC, while the dor
    // CLI sends the native Windows path (`C:\Users\...`) for the same directory.
    const bashPane = runningPane('/c/Users/me/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(bashPane, 'pnpm dev:website', 'C:\\Users\\me\\app')).toBe(true);
    // Drive-letter case and slash direction are folded too.
    const winPane = runningPane('c:/Users/me/app', 'pnpm dev:website');
    expect(surfaceRunsCommand(winPane, 'pnpm dev:website', 'C:\\Users\\me\\app')).toBe(true);
    // Genuinely different directories still do not match.
    expect(surfaceRunsCommand(bashPane, 'pnpm dev:website', 'C:\\Users\\me\\other')).toBe(false);
  });
});

function cwd(path: string, host?: string): CwdState {
  return {
    path,
    host,
    scheme: 'file',
    pathKind: path.includes(':') ? 'windows' : 'posix',
    isRemote: !!host && host !== 'localhost',
    source: 'manual',
    updatedAt: 1,
  };
}

function runningPane(path: string, command: string, host?: string) {
  const paneCwd = cwd(path, host);
  return createTerminalPaneState({
    cwd: paneCwd,
    activity: { kind: 'running' },
    currentCommand: {
      id: `${command}-${path}`,
      rawCommandLine: command,
      displayCommand: command,
      cwdAtStart: paneCwd,
      startedAt: 1,
      source: 'osc633_E',
    },
  });
}
