// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two teardown verbs differ in exactly one thing — whether the process
 * dies — and that difference is what makes a Workspace transfer possible
 * (`docs/specs/transport.md` → "Transferring a Workspace").
 */

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 }; }
  },
}));
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }));
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    parser = { registerCsiHandler: () => ({ dispose: () => {} }) };
    modes = { mouseTrackingMode: 'none' as const, bracketedPasteMode: false };
    unicode = { activeVersion: '11' };
    disposed = false;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    focus(): void {}
    blur(): void {}
    onData(): { dispose: () => void } { return { dispose: () => {} }; }
    onResize(): { dispose: () => void } { return { dispose: () => {} }; }
    onRender(): { dispose: () => void } { return { dispose: () => {} }; }
    dispose(): void { this.disposed = true; }
  },
}));

vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => fakePlatform, __fakePlatform: fakePlatform };
});

import * as platformModule from './platform';
import type { FakePtyAdapter } from './platform';
import {
  addPlainNote,
  addTerminalNote,
  getNotes,
  removeSurface,
} from './notepad/notepad-store';
import {
  disposeSession,
  getOrCreateTerminal,
  getTerminalInstance,
  releaseSession,
} from './terminal-registry';

const platform = (platformModule as unknown as { __fakePlatform: FakePtyAdapter }).__fakePlatform;

let killed: string[];

/** A pin, without a real xterm buffer behind it: what the notepad holds is two
 *  markers it must be able to dispose. */
function fakeSource(terminalId: string) {
  return {
    terminalId,
    startMarker: { line: 0, dispose: vi.fn() },
    endMarker: { line: 0, dispose: vi.fn() },
  } as unknown as Parameters<typeof addTerminalNote>[2];
}

beforeEach(() => {
  killed = [];
  vi.spyOn(platform, 'killPty').mockImplementation((id: string) => void killed.push(id));
  for (const id of ['pane-1', 'pane-2']) removeSurface(id);
});

describe('releaseSession', () => {
  it('never kills the PTY, unlike disposeSession', () => {
    getOrCreateTerminal('pane-1');
    releaseSession('pane-1');
    expect(killed).toEqual([]);

    getOrCreateTerminal('pane-2');
    disposeSession('pane-2');
    expect(killed).toEqual(['pane-2']);
  });

  it("drops this webview's half of the Session", () => {
    getOrCreateTerminal('pane-1');
    expect(getTerminalInstance('pane-1')).not.toBeNull();
    releaseSession('pane-1');
    // The registry entry and the xterm instance are gone: the target Window
    // builds its own over the same, still-running PTY.
    expect(getTerminalInstance('pane-1')).toBeNull();
  });

  it('leaves the notes for the transfer payload but drops their pins', () => {
    getOrCreateTerminal('pane-1');
    addPlainNote('pane-1', 'keep me');
    addTerminalNote('pane-1', [{ text: 'captured' }], fakeSource('pane-1'));

    releaseSession('pane-1');

    const notes = getNotes('pane-1');
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.content.kind)).toEqual(['plain', 'terminal']);
    // A pin is a marker in the xterm instance this release disposed, so it
    // cannot survive the move; the note itself rides the payload.
    expect(notes.every((note) => note.source === undefined)).toBe(true);
  });

  it('is a no-op for an id the registry does not hold', () => {
    expect(() => releaseSession('never-existed')).not.toThrow();
    expect(killed).toEqual([]);
  });
});
