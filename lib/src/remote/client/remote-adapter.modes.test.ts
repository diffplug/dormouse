// @vitest-environment jsdom
/**
 * A phone attaching to a program already running reads that program's modes
 * where the mobile composition looks for them: the pane's mouse-selection
 * state, which decides the Mouse chip, edge scrolling, and bracketed Send and
 * Paste. The real registry over a real xterm buffer, the attach driven by hand.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { DirectoryEntry, TerminalAttachResult } from 'remote-lib-common';

import { RemotePtyAdapter, type RemoteAdapterClient, type TerminalHandlers } from './remote-adapter';
import { FRESH_TERMINAL_MODES } from '../test-terminal-modes';

// xterm's real parser, so modes resolve; never opened, and the addons it loads
// are stand-ins, since no canvas can measure glyphs.
vi.mock('@xterm/xterm', async () => {
  const xterm = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
  class Terminal extends xterm.Terminal {
    override open(): void {}
    override loadAddon(): void {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('../../lib/xterm-test-mock'));

const attached = vi.hoisted(() => [] as TerminalHandlers[]);
const client: RemoteAdapterClient = {
  watchDirectory: async (_onSnapshot: (entries: DirectoryEntry[]) => void) => 'dir-sub',
  async attach(_surfaceId, cols, rows, handlers) {
    attached.push(handlers);
    return { subId: `attach-${attached.length}`, result: { cols, rows, modes: FRESH_TERMINAL_MODES } };
  },
  write: async () => {},
  resize: async () => {},
  detach: async () => {},
  unsubscribe: () => {},
};
const adapter = vi.hoisted(() => ({ current: null as RemotePtyAdapter | null }));
vi.mock('../../lib/platform', async () => {
  const actual = await vi.importActual<typeof import('../../lib/platform')>('../../lib/platform');
  return { ...actual, getPlatform: () => adapter.current };
});

import { getMouseSelectionState } from '../../lib/mouse-selection';
import { getOrCreateTerminal } from '../../lib/terminal-registry';

const flush = (terminal: Terminal) => new Promise<void>((resolve) => terminal.write('', resolve));

describe('a Pocket pane attached to a running program', () => {
  it('captures the mouse and brackets pastes as the program asked before the attach', async () => {
    adapter.current = new RemotePtyAdapter(client);
    const { terminal } = getOrCreateTerminal('surface:1');
    await adapter.current.setActivePane('surface:1', 80, 24);

    const result: TerminalAttachResult = { cols: 80, rows: 24, modes: { ...FRESH_TERMINAL_MODES, mouseTracking: 'vt200', bracketedPaste: true } };
    attached.at(-1)!.onAttached(result);
    await flush(terminal);

    expect(getMouseSelectionState('surface:1').mouseReporting).toBe('vt200');
    expect(getMouseSelectionState('surface:1').bracketedPaste).toBe(true);
  });
});
