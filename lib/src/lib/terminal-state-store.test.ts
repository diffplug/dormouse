import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTerminalSemanticEvents,
  fillTerminalProcessCwd,
  fillTerminalProcessCwdByPtyId,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  recordTerminalOutput,
  recordTerminalOutputByPtyId,
  recordTerminalUserInput,
  recordTerminalUserInputByPtyId,
  removeTerminalPaneState,
  resetTerminalPaneState,
  seedTerminalManualCwd,
  setTerminalUserTitle,
} from './terminal-state-store';
import { registry, type TerminalEntry } from './terminal-store';
import { DEFAULT_IDLE_TITLE, UNNAMED_PANEL_TITLE } from './terminal-state';

describe('terminal semantic state store command input fallback', () => {
  afterEach(() => {
    removeTerminalPaneState('pane');
    removeTerminalPaneState('pane-a');
    removeTerminalPaneState('pane-b');
    registry.delete('pane-b');
  });

  it('promotes a submitted prompt line into the current command immediately', () => {
    recordTerminalUserInput('pane', 'lazygit\r');

    expect(getTerminalPaneState('pane').currentCommand).toMatchObject({
      rawCommandLine: 'lazygit',
      displayCommand: 'lazygit',
      source: 'user_input',
    });
    expect(getTerminalPaneState('pane').activity).toEqual({ kind: 'running' });
  });

  it('returns to idle when the next prompt arrives without a command finish event', () => {
    recordTerminalUserInput('pane', 'lazygit\r');
    applyTerminalSemanticEvents('pane', [{ type: 'promptStart' }]);

    const state = getTerminalPaneState('pane');
    expect(state.currentCommand).toBeNull();
    expect(state.activity).toEqual({ kind: 'prompt' });
  });

  it('returns to idle when prompt-looking output follows a user-input command', () => {
    recordTerminalUserInput('pane', 'lazygit\r');
    recordTerminalOutput('pane', '\x1b[?1049l\r\nuser@host repo % ');

    const state = getTerminalPaneState('pane');
    expect(state.currentCommand).toBeNull();
    expect(state.activity).toEqual({ kind: 'editing' });
  });

  it('does not treat arbitrary command output as a returned prompt', () => {
    recordTerminalUserInput('pane', 'lazygit\r');
    recordTerminalOutput('pane', 'loading repositories...\r\n');

    expect(getTerminalPaneState('pane').currentCommand?.displayCommand).toBe('lazygit');
  });

  it('does not match command output that merely ends in a prompt-shaped suffix', () => {
    recordTerminalUserInput('pane', 'lazygit\r');
    recordTerminalOutput('pane', '\r\nstep 1: 50% complete\r\nstep 2: 95% \r\n');

    expect(getTerminalPaneState('pane').currentCommand?.displayCommand).toBe('lazygit');
  });

  it('ignores prompt-shaped lines emitted inside the alt-screen buffer', () => {
    recordTerminalUserInput('pane', 'lazygit\r');
    recordTerminalOutput(
      'pane',
      '\x1b[?1049h\r\nuser@host repo $ rendered by tui\r\nmore tui output',
    );

    expect(getTerminalPaneState('pane').currentCommand?.displayCommand).toBe('lazygit');
  });

  it('does not resurrect a disposed pane when a late process CWD arrives', () => {
    fillTerminalProcessCwd('pane', '/Users/me/project');
    expect(getTerminalPaneStateSnapshot().has('pane')).toBe(false);
  });

  it('seeds restored manual CWD after reset created a blank pane state', () => {
    resetTerminalPaneState('pane');

    seedTerminalManualCwd('pane', '/Users/me/project');

    expect(getTerminalPaneState('pane').cwd).toMatchObject({
      path: '/Users/me/project',
      source: 'manual',
    });
  });

  it('refuses to pin `<idle>` (or any title starting with `<idle>`) as a user title and reports the reason', () => {
    expect(setTerminalUserTitle('pane', DEFAULT_IDLE_TITLE)).toEqual({ accepted: false, reason: 'reserved' });
    expect(setTerminalUserTitle('pane', `${DEFAULT_IDLE_TITLE} npm run build`)).toEqual({ accepted: false, reason: 'reserved' });
    expect(setTerminalUserTitle('pane', `${DEFAULT_IDLE_TITLE}foo`)).toEqual({ accepted: false, reason: 'reserved' });
    expect(setTerminalUserTitle('pane', '   ')).toEqual({ accepted: false, reason: 'empty' });

    expect(getTerminalPaneState('pane').titleCandidates.user).toBeUndefined();

    expect(setTerminalUserTitle('pane', 'Production API')).toEqual({ accepted: true });
    expect(getTerminalPaneState('pane').titleCandidates.user?.title).toBe('Production API');
  });

  it('lets the user pin `<unnamed>` explicitly even though it is the default placeholder', () => {
    expect(setTerminalUserTitle('pane', UNNAMED_PANEL_TITLE)).toEqual({ accepted: true });
    expect(getTerminalPaneState('pane').titleCandidates.user?.title).toBe(UNNAMED_PANEL_TITLE);
  });

  it('records PTY fallback state under the current pane after a swap', () => {
    registry.set('pane-b', { ptyId: 'pane-a' } as unknown as TerminalEntry);

    recordTerminalUserInputByPtyId('pane-a', 'lazygit\r');

    expect(getTerminalPaneState('pane-a').currentCommand).toBeNull();
    expect(getTerminalPaneState('pane-b').currentCommand).toMatchObject({
      rawCommandLine: 'lazygit',
      displayCommand: 'lazygit',
      source: 'user_input',
    });

    recordTerminalOutputByPtyId('pane-a', '\r\nuser@host repo % ');

    expect(getTerminalPaneState('pane-b').currentCommand).toBeNull();
    expect(getTerminalPaneState('pane-b').activity).toEqual({ kind: 'editing' });
  });

  it('records process CWD under the current pane after a swap', () => {
    registry.set('pane-b', { ptyId: 'pane-a' } as unknown as TerminalEntry);
    applyTerminalSemanticEvents('pane-b', [{ type: 'promptStart' }]);

    fillTerminalProcessCwdByPtyId('pane-a', '/Users/me/project');

    expect(getTerminalPaneState('pane-a').cwd).toBeNull();
    expect(getTerminalPaneState('pane-b').cwd).toMatchObject({
      path: '/Users/me/project',
      source: 'process',
    });
  });
});
