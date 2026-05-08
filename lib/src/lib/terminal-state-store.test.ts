import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTerminalSemanticEvents,
  getTerminalPaneState,
  recordTerminalOutput,
  recordTerminalOutputByPtyId,
  recordTerminalUserInput,
  recordTerminalUserInputByPtyId,
  removeTerminalPaneState,
} from './terminal-state-store';
import { registry, type TerminalEntry } from './terminal-store';

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
});
