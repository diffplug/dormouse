// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { attachMouseModeObserver } from './mouse-mode-observer';
import { __resetMouseSelectionForTests, getMouseSelectionState, setOverride, setSelection } from './mouse-selection';

const live: Terminal[] = [];
afterEach(() => {
  for (const terminal of live.splice(0)) terminal.dispose();
  __resetMouseSelectionForTests();
});

function setup() {
  const terminal = new Terminal({ allowProposedApi: true });
  live.push(terminal);
  const observer = attachMouseModeObserver('a', terminal);
  return { terminal, observer };
}
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));

describe('attachMouseModeObserver', () => {
  it.each([[9, 'x10'], [1000, 'vt200'], [1002, 'drag'], [1003, 'any']] as const)(
    'tracks mouse mode %i through real xterm parsing', async (mode, expected) => {
      const { terminal } = setup();
      await write(terminal, `[?${mode}h[?2004h`);
      expect(getMouseSelectionState('a')).toMatchObject({ mouseReporting: expected, bracketedPaste: true });
      await write(terminal, `[?${mode}l[?2004l`);
      expect(getMouseSelectionState('a')).toMatchObject({ mouseReporting: 'none', bracketedPaste: false });
    },
  );

  it('clears reporting, override, program selection, and paste mode after a hard reset', async () => {
    const { terminal } = setup();
    await write(terminal, '\x1b[?1003h\x1b[?2004h');
    setOverride('a', 'permanent');
    setSelection('a', { startRow: 0, startCol: 0, endRow: 0, endCol: 4, shape: 'linewise', dragging: false, startedInScrollback: false, owner: 'program' });
    await write(terminal, '\x1bc');
    expect(terminal.modes.mouseTrackingMode).toBe('none');
    expect(terminal.modes.bracketedPasteMode).toBe(false);
    expect(getMouseSelectionState('a')).toMatchObject({ mouseReporting: 'none', bracketedPaste: false, override: 'off', selection: null });
  });

  it('reads the resolved soft-reset modes instead of assuming mouse tracking ended', async () => {
    const { terminal } = setup();
    await write(terminal, '\x1b[?1003h\x1b[?2004h');
    await write(terminal, '\x1b[!p');
    expect(terminal.modes.mouseTrackingMode).toBe('any');
    expect(terminal.modes.bracketedPasteMode).toBe(false);
    expect(getMouseSelectionState('a')).toMatchObject({ mouseReporting: 'any', bracketedPaste: false });
  });

  it('stops updating the store after disposal', async () => {
    const { terminal, observer } = setup();
    await write(terminal, '\x1b[?1003h\x1b[?2004h');
    observer.dispose();
    await write(terminal, '\x1b[?1003l\x1b[?2004l');
    expect(getMouseSelectionState('a')).toMatchObject({ mouseReporting: 'any', bracketedPaste: true });
  });
});
