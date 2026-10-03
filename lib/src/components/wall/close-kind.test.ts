import { afterEach, describe, expect, it, vi } from 'vitest';
import * as helpers from '../../lib/helper-terminal';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from '../../lib/terminal-state-store';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
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
  resetToolDirty();
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

describe('closeKind reopenable kinds', () => {
  const builtin = (toolName: string) => ({ surfaceType: 'tool', command: `dor __view-${toolName} /repo/x`, toolScope: 'builtin', toolName, toolRender: 'iframe', toolPort: 'announced' });
  const viewing = () => applyTerminalSemanticEvents('pane', [{ type: 'commandLine', commandLine: 'dor __view-file /repo/x' }, { type: 'commandStart' }]);

  it.each([
    ['an iframe browser', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/' }, 'reopenable'],
    ['an agent-browser', { surfaceType: 'browser', renderMode: 'agent-browser-screencast', url: 'http://localhost:5173/' }, 'confirm'],
    ['a playwright browser', { surfaceType: 'browser', renderMode: 'playwright-screencast', url: 'http://localhost:5173/' }, 'confirm'],
  ] as const)('classifies %s', (_label, params, kind) => {
    expect(closeKind('pane', params)).toBe(kind);
  });

  it('reopens a running builtin:folder without asking', () => {
    viewing();
    expect(closeKind('pane', builtin('folder'))).toBe('reopenable');
  });

  it('reopens a running builtin:file only once it has reported clean', () => {
    viewing();
    expect(closeKind('pane', builtin('file'))).toBe('confirm');
    recordToolDirty('pane', true);
    expect(closeKind('pane', builtin('file'))).toBe('confirm');
    recordToolDirty('pane', false);
    expect(closeKind('pane', builtin('file'))).toBe('reopenable');
  });

  it('confirms a builtin whose command has ended, leaving its shell', () => {
    recordToolDirty('pane', false);
    expect(closeKind('pane', builtin('file'))).toBe('confirm');
    expect(closeKind('pane', builtin('folder'))).toBe('confirm');
  });

  it.each([
    ['builtin:code', builtin('code')],
    ['a repo Tool', { surfaceType: 'tool', command: 'pnpm storybook', toolScope: 'user', toolName: 'storybook' }],
  ])('confirms %s, which the table leaves out', (_label, params) => {
    viewing();
    recordToolDirty('pane', false);
    expect(closeKind('pane', params)).toBe('confirm');
  });
});
