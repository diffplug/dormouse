// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));
vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const platform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => platform };
});

import { getPlatform } from './platform';
import { disposeAllSessions, disposeSession, getOrCreateTerminal, reapTerminal, rehydrateTerminal } from './terminal-registry';
import { getTerminalPaneState } from './terminal-state-store';

let answers: Array<(cwd: string | null) => void>;
beforeEach(() => {
  vi.useFakeTimers();
  answers = [];
  vi.spyOn(getPlatform(), 'getCwd').mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
});
afterEach(() => {
  disposeAllSessions();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const settle = async (index: number, cwd: string) => {
  answers[index](cwd);
  await Promise.resolve();
};

describe('spawn process CWD', () => {
  it('leaves the directory unknown when the process lookup fails', async () => {
    vi.mocked(getPlatform().getCwd).mockRejectedValueOnce(new Error('host unavailable'));
    getOrCreateTerminal('pane');
    await Promise.resolve();
    await Promise.resolve();
    expect(getTerminalPaneState('pane').cwd).toBeNull();
  });

  it('fills the current run from its process lookup', async () => {
    getOrCreateTerminal('pane');
    await settle(0, '/current');
    expect(getTerminalPaneState('pane').cwd).toMatchObject({ path: '/current', source: 'process' });
  });

  it('does not apply the disposed entry answer to its replacement', async () => {
    getOrCreateTerminal('pane');
    disposeSession('pane');
    getOrCreateTerminal('pane');
    await settle(1, '/new');
    await settle(0, '/old');
    expect(getTerminalPaneState('pane').cwd?.path).toBe('/new');
  });

  it('drops an answer after the Tool is reaped', async () => {
    getOrCreateTerminal('pane');
    reapTerminal('pane');
    await settle(0, '/old');
    expect(getTerminalPaneState('pane').cwd).toBeNull();
  });

  it('does not let the old run overwrite a rehydrated Tool using the same entry', async () => {
    const entry = getOrCreateTerminal('pane');
    reapTerminal('pane');
    rehydrateTerminal('pane', { cwd: '/new', command: 'tool' });
    expect(getOrCreateTerminal('pane')).toBe(entry);
    await settle(1, '/new-process');
    await settle(0, '/old');
    expect(getTerminalPaneState('pane').cwd?.path).toBe('/new-process');
  });
});
