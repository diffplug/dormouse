/**
 * The extension host's in-memory notepad mirror (`docs/specs/notepad.md` →
 * Archive and Lifecycle).
 *
 * It exists because VS Code can destroy a webview without asking, so a teardown
 * has to archive from here instead of from the Surface. What that makes
 * load-bearing: what it refuses to mirror (anything the archive validator would
 * later choke on), whose notes a router may retire, and the fact that a live
 * resume reads it without consuming it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VolatileSurfaceNotes } from '../../lib/src/lib/notepad/types';

type MirrorModule = typeof import('../src/notepad-volatile');

let mirror: MirrorModule;

beforeEach(async () => {
  // Module state is the mirror, exactly as it is in a real extension host, so
  // each test gets its own host.
  vi.resetModules();
  mirror = await import('../src/notepad-volatile');
});

function surface(surfaceId: string, text = 'note'): VolatileSurfaceNotes {
  return {
    surfaceId,
    surfaceTitle: `title ${surfaceId}`,
    surfaceKind: 'terminal',
    cwd: null,
    notes: [{ id: `${surfaceId}-n1`, createdAt: 1, content: { kind: 'plain', text } }],
  };
}

const noDeletions = { deleteBatchIds: [], deleteNotes: [] };

describe('the volatile notepad mirror', () => {
  it('refuses a Surface the archive validator would later reject', () => {
    // One malformed note written verbatim into globalState would make the whole
    // archive unreadable on the next load — and by then there is no webview left
    // to blame. So the mirror is the gate.
    mirror.setVolatileForRouter('router-1', {
      surfaces: [
        surface('good'),
        { ...surface('bad-kind'), surfaceKind: 'spreadsheet' },
        { ...surface('bad-note'), notes: [{ id: 'n', createdAt: 'yesterday', content: { kind: 'plain', text: '' } }] },
        { ...surface('bad-colour'), notes: [{
          id: 'n', createdAt: 1, content: { kind: 'terminal', runs: [{ text: 'x', foreground: 'red' }] },
        }] },
        { surfaceId: '', surfaceTitle: 't', surfaceKind: 'terminal', cwd: null, notes: [] },
      ],
      stagedDeletions: noDeletions,
    });

    expect(mirror.surfaceIdsForRouter('router-1')).toEqual(['good']);
  });

  it('keeps a rich note whole, and drops the fields the archive does not carry', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [{
        ...surface('pane-1'),
        // `source` is the runtime marker link, which is never archived.
        notes: [{
          id: 'n1', createdAt: 1, source: { terminalId: 't' },
          content: { kind: 'terminal', runs: [{ text: 'ok', bold: true, foreground: '#00ff00' }] },
        }],
      }],
      stagedDeletions: noDeletions,
    });

    const [mirrored] = mirror.takeVolatileForSurfaces(['pane-1']);
    expect(mirrored.notes).toEqual([{
      id: 'n1',
      createdAt: 1,
      content: { kind: 'terminal', runs: [{ text: 'ok', bold: true, foreground: '#00ff00' }] },
    }]);
  });

  it('lets a router retire only what it stopped reporting', () => {
    // Two webviews mirror into the same map. A snapshot that no longer mentions
    // a Surface means that Surface closed through the ordinary path — but only
    // for the router that sent it.
    mirror.setVolatileForRouter('router-1', {
      surfaces: [surface('a'), surface('b')],
      stagedDeletions: noDeletions,
    });
    mirror.setVolatileForRouter('router-2', { surfaces: [surface('c')], stagedDeletions: noDeletions });

    mirror.setVolatileForRouter('router-1', { surfaces: [surface('b')], stagedDeletions: noDeletions });

    expect(mirror.surfaceIdsForRouter('router-1')).toEqual(['b']);
    expect(mirror.surfaceIdsForRouter('router-2')).toEqual(['c']);
  });

  it('hands a live resume its own panes without consuming them', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [surface('pane-1'), surface('pane-2')],
      stagedDeletions: { deleteBatchIds: ['batch-1'], deleteNotes: [] },
    });

    const resumed = mirror.snapshotForLiveResume(['pane-1', 'pane-missing']);
    expect(resumed!.surfaces.map((s) => s.surfaceId)).toEqual(['pane-1']);
    // Deletions are archive-wide, so a resume inherits what was staged behind it.
    expect(resumed!.stagedDeletions.deleteBatchIds).toEqual(['batch-1']);

    // Still mirrored: a webview served this and then lost (a crash before its
    // first sync) must still have its notes archived at deactivate.
    expect(mirror.surfaceIdsForRouter('router-1')).toEqual(['pane-1', 'pane-2']);
  });

  it('gives a cold restore nothing', () => {
    mirror.setVolatileForRouter('router-1', { surfaces: [surface('pane-1')], stagedDeletions: noDeletions });
    // A cold restore's pane ids are from a previous extension host; nothing in
    // this one's memory answers to them.
    expect(mirror.snapshotForLiveResume(['pane-from-last-week'])).toBeNull();
  });

  it('drains one router without touching another', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [surface('a')],
      stagedDeletions: { deleteBatchIds: ['batch-1'], deleteNotes: [] },
    });
    mirror.setVolatileForRouter('router-2', {
      surfaces: [surface('b')],
      stagedDeletions: { deleteBatchIds: ['batch-2'], deleteNotes: [] },
    });

    const drained = mirror.takeVolatileForRouter('router-1');
    expect(drained.surfaces.map((s) => s.surfaceId)).toEqual(['a']);
    expect(drained.stagedDeletions.deleteBatchIds).toEqual(['batch-1']);

    // Drained means gone: `deactivate()` must not archive these a second time
    // under a fresh batch id.
    expect(mirror.takeVolatileForRouter('router-1').surfaces).toEqual([]);
    expect(mirror.surfaceIdsForRouter('router-2')).toEqual(['b']);
  });

  it('drains every router at once, merging their staged deletions', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [surface('a')],
      stagedDeletions: { deleteBatchIds: ['batch-1'], deleteNotes: [{ batchId: 'batch-9', noteId: 'n1' }] },
    });
    mirror.setVolatileForRouter('router-2', {
      surfaces: [surface('b')],
      stagedDeletions: { deleteBatchIds: ['batch-1', 'batch-2'], deleteNotes: [] },
    });

    const all = mirror.takeAllVolatile();
    expect(all.surfaces.map((s) => s.surfaceId).sort()).toEqual(['a', 'b']);
    expect(all.stagedDeletions.deleteBatchIds.sort()).toEqual(['batch-1', 'batch-2']);
    expect(all.stagedDeletions.deleteNotes).toEqual([{ batchId: 'batch-9', noteId: 'n1' }]);
    expect(mirror.takeAllVolatile().surfaces).toEqual([]);
  });
});
