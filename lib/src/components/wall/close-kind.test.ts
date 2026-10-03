import { afterEach, describe, expect, it, vi } from 'vitest';
import * as helpers from '../../lib/helper-terminal';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from '../../lib/terminal-state-store';
import { closeKind } from './close-kind';

const SHELL = undefined;
const TOOL = { surfaceType: 'tool', command: 'pnpm storybook' };

function shell(id: string, entry: Partial<TerminalEntry>): void {
  registry.set(id, entry as TerminalEntry);
}

function withHelper(entry: Partial<TerminalEntry>): void {
  vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane' ? { id: 'helper', parentId: 'pane', command: '', status: 'off' } : undefined);
  shell('helper', entry);
}

afterEach(() => {
  vi.restoreAllMocks();
  registry.clear();
  removeTerminalPaneState('pane');
});

describe('closeKind', () => {
  it('takes an untouched idle shell without asking', () => {
    shell('pane', { untouched: true });
    expect(closeKind('pane', SHELL)).toBe('trivial');
  });

  it('confirms a touched shell', () => {
    shell('pane', { untouched: false });
    expect(closeKind('pane', SHELL)).toBe('confirm');
  });

  // `untouched` alone is not evidence of idleness: a restored agent runs in one.
  it('confirms an untouched shell whose command is running', () => {
    shell('pane', { untouched: true });
    applyTerminalSemanticEvents('pane', [{ type: 'commandStart' }]);
    expect(closeKind('pane', SHELL)).toBe('confirm');
  });

  it('never takes a Tool without asking', () => {
    shell('pane', { untouched: true });
    expect(closeKind('pane', TOOL)).toBe('confirm');
  });

  it('confirms an untouched shell whose helper holds user input', () => {
    shell('pane', { untouched: true });
    withHelper({ untouched: false, helperBusy: false });
    expect(closeKind('pane', SHELL)).toBe('confirm');
  });

  it('confirms an untouched shell whose helper the host has not answered for', () => {
    shell('pane', { untouched: true });
    withHelper({ untouched: true });
    expect(closeKind('pane', SHELL)).toBe('confirm');
  });

  it.each([
    ['idle', { untouched: true, helperBusy: false }],
    ['exited', { untouched: true, exited: true }],
  ])('takes an untouched shell whose untouched helper is %s without asking', (_label, helperEntry) => {
    shell('pane', { untouched: true });
    withHelper(helperEntry);
    expect(closeKind('pane', SHELL)).toBe('trivial');
  });
});
