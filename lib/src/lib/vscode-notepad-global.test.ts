/**
 * The boot global carrying the VS Code volatile notepad mirror. The host wrote
 * it, but what comes out reaches the live notepad store and from there the
 * archive, so this is the boundary check: anything that would not read back
 * through the archive validator degrades to no mirror rather than to entries
 * nobody validated (`docs/specs/notepad.md` → "Live resume").
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CwdState } from './terminal-state';
import { NOTEPAD_VOLATILE_GLOBAL, readInjectedVolatileNotepad } from './vscode-notepad-global';

const CWD: CwdState = {
  path: '/srv/app',
  pathKind: 'posix',
  isRemote: false,
  source: 'osc7',
  updatedAt: 5,
};

function inject(value: unknown): void {
  (globalThis as unknown as Record<string, unknown>)[NOTEPAD_VOLATILE_GLOBAL] = value;
}

function surface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: 'pane-1',
    surfaceTitle: 'zsh',
    surfaceKind: 'terminal',
    cwd: CWD,
    notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'remember this' } }],
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[NOTEPAD_VOLATILE_GLOBAL];
});

describe('readInjectedVolatileNotepad', () => {
  it('is null on a boot that is not a live resume', () => {
    expect(readInjectedVolatileNotepad()).toBeNull();
    inject('not an object');
    expect(readInjectedVolatileNotepad()).toBeNull();
  });

  it('reads a well-formed mirror whole, cwd included', () => {
    inject({ surfaces: [surface()], stagedDeletions: { deleteBatchIds: [], deleteNotes: [] } });

    const mirror = readInjectedVolatileNotepad();
    expect(mirror!.surfaces).toEqual([{
      surfaceId: 'pane-1',
      surfaceTitle: 'zsh',
      surfaceKind: 'terminal',
      cwd: CWD,
      notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'remember this' } }],
    }]);
  });

  it('drops a Surface whose kind is not one of the known kinds', () => {
    inject({ surfaces: [surface({ surfaceKind: 'spreadsheet' }), surface({ surfaceId: 'pane-2' })] });
    expect(readInjectedVolatileNotepad()!.surfaces.map((s) => s.surfaceId)).toEqual(['pane-2']);
  });

  it('drops a Surface whole when any one of its notes is invalid', () => {
    // Half a notepad is worse than none: the missing notes would look deleted,
    // and the ones that survived would be archived as the whole thing.
    inject({
      surfaces: [
        surface({
          notes: [
            { id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'good' } },
            { id: 'n2', createdAt: 'yesterday', content: { kind: 'plain', text: 'bad' } },
          ],
        }),
        surface({ surfaceId: 'pane-2' }),
      ],
    });
    expect(readInjectedVolatileNotepad()!.surfaces.map((s) => s.surfaceId)).toEqual(['pane-2']);
  });

  it('drops a run colour the archive would reject, with its Surface', () => {
    inject({
      surfaces: [surface({
        notes: [{ id: 'n1', createdAt: 1, content: { kind: 'terminal', runs: [{ text: 'x', foreground: 'red' }] } }],
      })],
    });
    expect(readInjectedVolatileNotepad()!.surfaces).toEqual([]);
  });

  it('keeps a Surface whose cwd is malformed, with no cwd', () => {
    // The CWD is metadata for a batch this Surface has not written yet, so a bad
    // one is dropped rather than costing the user their notes.
    inject({ surfaces: [surface({ cwd: { path: '/srv/app', pathKind: 'martian' } })] });
    const [read] = readInjectedVolatileNotepad()!.surfaces;
    expect(read.cwd).toBeNull();
    expect(read.notes).toHaveLength(1);

    // A field outside `CwdState` is malformed too, for the same reason the
    // archive refuses one: the batch this Surface writes would drop it.
    inject({ surfaces: [surface({ cwd: { ...CWD, drive: 'C:' } })] });
    expect(readInjectedVolatileNotepad()!.surfaces[0].cwd).toBeNull();
  });

  it('drops a Surface whose note carries a field the archive does not know', () => {
    inject({
      surfaces: [
        surface({ notes: [{ id: 'n1', createdAt: 1, source: { terminalId: 't1' }, content: { kind: 'plain', text: 'x' } }] }),
        surface({ surfaceId: 'pane-2' }),
      ],
    });
    expect(readInjectedVolatileNotepad()!.surfaces.map((s) => s.surfaceId)).toEqual(['pane-2']);
  });
});
