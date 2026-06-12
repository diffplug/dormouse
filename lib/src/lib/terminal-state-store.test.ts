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
  seedLaunchedCommand,
  seedPromptShapeFromScrollback,
  seedTerminalManualCwd,
  setTerminalUserTitle,
} from './terminal-state-store';
import { registry, type TerminalEntry } from './terminal-store';
import { DEFAULT_IDLE_TITLE, surfaceRunsCommand, UNNAMED_PANEL_TITLE } from './terminal-state';

const PROMPT = 'user@host repo % ';

// A reader that always renders `PROMPT + command` (what the shell would have on
// screen at submit time). Pass a different rendered line to simulate recall etc.
function lineReader(renderedLine: string | null) {
  return { readLine: () => renderedLine };
}

// Learn the prompt shape (as if the shell drew a bare prompt) and submit
// `command`, rendering `PROMPT + command` in the buffer.
function submit(id: string, command: string): void {
  recordTerminalOutput(id, PROMPT);
  recordTerminalUserInput(id, '\r', lineReader(`${PROMPT}${command}`));
}

describe('terminal semantic state store command input fallback', () => {
  afterEach(() => {
    removeTerminalPaneState('pane');
    removeTerminalPaneState('pane-a');
    removeTerminalPaneState('pane-b');
    registry.delete('pane-b');
  });

  it('promotes a submitted prompt line into the current command immediately', () => {
    submit('pane', 'lazygit');

    expect(getTerminalPaneState('pane').currentCommand).toMatchObject({
      rawCommandLine: 'lazygit',
      displayCommand: 'lazygit',
      source: 'user_input',
    });
    expect(getTerminalPaneState('pane').activity).toEqual({ kind: 'running' });
  });

  it('returns to idle when the next prompt arrives without a command finish event', () => {
    submit('pane', 'lazygit');
    applyTerminalSemanticEvents('pane', [{ type: 'promptStart' }]);

    const state = getTerminalPaneState('pane');
    expect(state.currentCommand).toBeNull();
    expect(state.activity).toEqual({ kind: 'prompt' });
  });

  it('retires the keystroke fallback once the shell emits real OSC command boundaries', () => {
    // Shell integration draws its first prompt before any command is typed.
    applyTerminalSemanticEvents('pane', [{ type: 'promptStart' }]);
    // The user then runs a command; OSC drives it, the keystroke path must not.
    submit('pane', 'lazygit');

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });

  it('lets the OSC command-start win instead of double-counting with keystrokes', () => {
    applyTerminalSemanticEvents('pane', [{ type: 'commandStart', source: 'osc633_boundaries' }]);
    submit('pane', 'lazygit');

    // currentCommand stays the OSC-sourced one; no user_input command is layered on.
    expect(getTerminalPaneState('pane').currentCommand?.source).toBe('osc633_boundaries');
  });

  it('keeps the keystroke fallback alive across its own synthesized prompt markers', () => {
    submit('pane', 'first');
    // The heuristic itself emits promptStart/promptEnd here — that must not be
    // mistaken for shell integration and silence the fallback.
    recordTerminalOutput('pane', '\r\nuser@host repo % ');
    submit('pane', 'second');

    expect(getTerminalPaneState('pane').currentCommand).toMatchObject({
      source: 'user_input',
      rawCommandLine: 'second',
    });
  });

  it('returns to idle when prompt-looking output follows a user-input command', () => {
    submit('pane', 'lazygit');
    recordTerminalOutput('pane', '\x1b[?1049l\r\nuser@host repo % ');

    const state = getTerminalPaneState('pane');
    expect(state.currentCommand).toBeNull();
    expect(state.activity).toEqual({ kind: 'editing' });
  });

  it('does not treat arbitrary command output as a returned prompt', () => {
    submit('pane', 'lazygit');
    recordTerminalOutput('pane', 'loading repositories...\r\n');

    expect(getTerminalPaneState('pane').currentCommand?.displayCommand).toBe('lazygit');
  });

  it('does not match command output that merely ends in a prompt-shaped suffix', () => {
    submit('pane', 'lazygit');
    recordTerminalOutput('pane', '\r\nstep 1: 50% complete\r\nstep 2: 95% \r\n');

    expect(getTerminalPaneState('pane').currentCommand?.displayCommand).toBe('lazygit');
  });

  it('ignores prompt-shaped lines emitted inside the alt-screen buffer', () => {
    submit('pane', 'lazygit');
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

    recordTerminalOutputByPtyId('pane-a', PROMPT);
    recordTerminalUserInputByPtyId('pane-a', '\r', lineReader(`${PROMPT}lazygit`));

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

describe('terminal command input via rendered buffer', () => {
  afterEach(() => {
    removeTerminalPaneState('pane');
  });

  it('learns the shape from the first prompt and extracts a typed command', () => {
    recordTerminalOutput('pane', PROMPT); // cold-start prompt → learns the shape
    recordTerminalUserInput('pane', 'pnpm dev:website\r', lineReader(`${PROMPT}pnpm dev:website`));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('pnpm dev:website');
  });

  it('recovers a history-recalled command — no keystrokes required', () => {
    recordTerminalOutput('pane', PROMPT);
    // Up-arrow then Enter: the command never arrives as keystrokes, but the
    // shell rendered it, so the reader supplies the full line.
    recordTerminalUserInput('pane', '\x1b[A', lineReader(`${PROMPT}pnpm dev:website`));
    recordTerminalUserInput('pane', '\r', lineReader(`${PROMPT}pnpm dev:website`));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('pnpm dev:website');
  });

  it('captures flags appended to a recalled command', () => {
    recordTerminalOutput('pane', PROMPT);
    recordTerminalUserInput('pane', '\r', lineReader(`${PROMPT}pnpm dev:website --port 3000`));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('pnpm dev:website --port 3000');
  });

  it('stays idle when no prompt shape has been learned yet', () => {
    recordTerminalUserInput('pane', 'lazygit\r', lineReader(`${PROMPT}lazygit`));

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });

  it('stays idle when the buffer is unreadable', () => {
    recordTerminalOutput('pane', PROMPT);
    recordTerminalUserInput('pane', 'lazygit\r', lineReader(null));

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });

  it('does not submit on a newline pasted inside a bracketed paste', () => {
    recordTerminalOutput('pane', PROMPT);
    recordTerminalUserInput('pane', '\x1b[200~line one\nline two\x1b[201~', lineReader(`${PROMPT}line one`));

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });

  it('seeds the shape from restored scrollback so the first command is titled', () => {
    // Reconnect to a live pty: the shell won't re-emit its prompt, so the shape
    // must come from the replayed scrollback that ends at the idle prompt.
    seedPromptShapeFromScrollback('pane', `earlier output\r\n${PROMPT}`);
    recordTerminalUserInput('pane', 'pnpm build\r', lineReader(`${PROMPT}pnpm build`));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('pnpm build');
  });

  it('detects a cmd.exe prompt (terminator with no trailing space) and titles the command', () => {
    recordTerminalOutput('pane', 'C:\\Users\\ntwigg>');
    recordTerminalUserInput('pane', 'claude\r', lineReader('C:\\Users\\ntwigg>claude'));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('claude');
  });

  it('detects a Git Bash two-line prompt (bare `$ ` under a context line)', () => {
    recordTerminalOutput('pane', 'ntwigg@PC MINGW64 /c/proj (main)\r\n$ ');
    recordTerminalUserInput('pane', 'claude\r', lineReader('$ claude'));

    expect(getTerminalPaneState('pane').currentCommand?.rawCommandLine).toBe('claude');
  });

  it('does not treat a bare `$ ` line without preceding context as a prompt', () => {
    recordTerminalOutput('pane', 'just some output\r\n$ ');
    recordTerminalUserInput('pane', 'claude\r', lineReader('$ claude'));

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });

  it('does not seed a shape when scrollback ends mid-output', () => {
    seedPromptShapeFromScrollback('pane', 'building ~/app...\r\n[1234/5678] compiling');
    recordTerminalUserInput('pane', 'pnpm build\r', lineReader(`${PROMPT}pnpm build`));

    expect(getTerminalPaneState('pane').currentCommand).toBeNull();
  });
});

describe('seedLaunchedCommand (dor split/ensure -lc launches)', () => {
  afterEach(() => removeTerminalPaneState('launch'));

  it('reports a launched command so ensure can match it, then clears it on finish', () => {
    seedLaunchedCommand('launch', 'pnpm dev:website', '/repo/app');

    const live = getTerminalPaneState('launch');
    expect(live.currentCommand?.rawCommandLine).toBe('pnpm dev:website');
    expect(live.currentCommand?.cwdAtStart?.path).toBe('/repo/app');
    expect(surfaceRunsCommand(live, 'pnpm dev:website', '/repo/app')).toBe(true);

    applyTerminalSemanticEvents('launch', [{ type: 'commandFinish', exitCode: 0 }]);

    const done = getTerminalPaneState('launch');
    expect(done.currentCommand).toBeNull();
    expect(surfaceRunsCommand(done, 'pnpm dev:website', '/repo/app')).toBe(false);
  });
});
