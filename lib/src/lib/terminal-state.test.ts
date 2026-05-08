import { describe, expect, it } from 'vitest';
import {
  createTerminalPaneState,
  cwdDisplay,
  cwdFromManualPath,
  cwdFromOsc7,
  cwdFromOsc9_9,
  cwdIdentity,
  deriveHeader,
  groupTerminalPanes,
  reduceTerminalState,
  shortestUniqueCwdLabels,
  summarizeCommandLine,
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

  it('keeps pipelines and compound commands recognizable', () => {
    expect(summarizeCommandLine('cat package.json | jq .name')).toBe('cat package.json | ...');
    expect(summarizeCommandLine('cd lib && pnpm test')).toBe('cd lib ...');
    expect(summarizeCommandLine('"my command" "quoted arg"')).toBe('my command quoted arg');
  });
});

describe('header and grouping derivation', () => {
  it('uses command start CWD for running headers and disambiguates duplicates', () => {
    const app = runningPane('/repo/app', 'pnpm test --watch');
    const api = runningPane('/repo/api', 'pnpm test --watch');

    expect(deriveHeader(app, [app, api])).toEqual({
      primary: 'pnpm test --watch',
      secondary: 'app',
      status: 'running',
    });
    expect(deriveHeader(api, [app, api])).toEqual({
      primary: 'pnpm test --watch',
      secondary: 'api',
      status: 'running',
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
    expect(groupTerminalPanes([running, idle], 'command').map((group) => group.label)).toEqual(['npm run dev', 'shell']);
    expect(groupTerminalPanes([running, idle, finished], 'status').map((group) => group.key)).toEqual([
      'running',
      'unknown',
      'finished',
    ]);
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
