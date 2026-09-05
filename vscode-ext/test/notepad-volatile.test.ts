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
import type { CwdState } from '../../lib/src/lib/terminal-state';

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
        // A field the validator does not know. The webview strips the runtime
        // marker link before mirroring, so one arriving here is not our snapshot
        // — and storing it would erase it again on the next mutation anyway.
        { ...surface('foreign-field'), notes: [{
          id: 'n', createdAt: 1, source: { terminalId: 't' }, content: { kind: 'plain', text: 'x' },
        }] },
        { surfaceId: '', surfaceTitle: 't', surfaceKind: 'terminal', cwd: null, notes: [] },
      ],
      stagedDeletions: noDeletions,
    });

    expect(mirror.surfaceIdsForRouter('router-1')).toEqual(['good']);
  });

  it('keeps a rich note whole', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [{
        ...surface('pane-1'),
        notes: [{
          id: 'n1', createdAt: 1,
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
    // Never a pending deletion: the disposal that produced this resume already
    // committed the staged set, so showing it as still-stageable would promise
    // an Undo that no longer exists.
    expect(resumed!.stagedDeletions).toEqual(noDeletions);

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

  it('takes a router\'s staged deletions without touching its notes', () => {
    // What a non-killing disposal does: the deletions are committed there and
    // then, the notes stay for the next resolve to hydrate.
    mirror.setVolatileForRouter('router-1', {
      surfaces: [surface('a')],
      stagedDeletions: { deleteBatchIds: ['batch-1'], deleteNotes: [{ batchId: 'batch-9', noteId: 'n1' }] },
    });

    const staged = mirror.takeStagedForRouter('router-1');
    expect(staged.deleteBatchIds).toEqual(['batch-1']);
    expect(staged.deleteNotes).toEqual([{ batchId: 'batch-9', noteId: 'n1' }]);

    expect(mirror.surfaceIdsForRouter('router-1')).toEqual(['a']);
    // Taken means gone: `deactivate()` must not re-commit them hours later.
    expect(mirror.takeStagedForRouter('router-1')).toEqual(noDeletions);
    expect(mirror.takeAllVolatile().stagedDeletions).toEqual(noDeletions);
  });

  it('carries a Surface\'s PTY id through, and only when it is a string', () => {
    mirror.setVolatileForRouter('router-1', {
      surfaces: [
        { ...surface('a'), terminalId: 'pty-9' },
        { ...surface('b'), terminalId: 7 },
        surface('c'),
      ],
      stagedDeletions: noDeletions,
    });

    const taken = mirror.takeVolatileForSurfaces(['a', 'b', 'c']);
    expect(taken.map((s) => s.terminalId)).toEqual(['pty-9', undefined, undefined]);
    // Absent, not present-and-undefined: `batchFromVolatile` never copies it,
    // and the validator would reject a batch that carried it.
    expect(Object.keys(taken[2])).not.toContain('terminalId');
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

describe('refreshMirrorCwds', () => {
  const OSC7: CwdState = {
    path: '/srv/app',
    pathKind: 'posix',
    isRemote: false,
    source: 'osc7',
    updatedAt: 5,
  };

  function snapshot(...surfaces: VolatileSurfaceNotes[]) {
    return { surfaces, stagedDeletions: noDeletions };
  }

  it('fills a mirrored Surface that reported no CWD from its live PTY', async () => {
    const getCwd = vi.fn(async () => '/Users/me/project');

    const refreshed = await mirror.refreshMirrorCwds(
      snapshot({ ...surface('a'), terminalId: 'pty-9' }),
      getCwd,
      50,
    );

    expect(getCwd).toHaveBeenCalledWith('pty-9');
    expect(refreshed.surfaces[0].cwd).toMatchObject({ path: '/Users/me/project', source: 'process' });
    // The rest of the mirror is untouched.
    expect(refreshed.surfaces[0].notes).toEqual(surface('a').notes);
    expect(refreshed.stagedDeletions).toEqual(noDeletions);
  });

  it('replaces a stale process CWD but never one the shell integration reported', async () => {
    const stale: CwdState = { ...OSC7, path: '/old', source: 'process' };
    const getCwd = vi.fn(async () => '/new');

    const refreshed = await mirror.refreshMirrorCwds(
      snapshot(
        { ...surface('a'), cwd: stale, terminalId: 'pty-a' },
        { ...surface('b'), cwd: OSC7, terminalId: 'pty-b' },
      ),
      getCwd,
      50,
    );

    expect(refreshed.surfaces[0].cwd).toMatchObject({ path: '/new', source: 'process' });
    expect(refreshed.surfaces[1].cwd).toEqual(OSC7);
    expect(getCwd).toHaveBeenCalledTimes(1);
  });

  it('never asks about a Surface with no PTY id', async () => {
    const getCwd = vi.fn(async () => '/Users/me/project');

    const refreshed = await mirror.refreshMirrorCwds(snapshot(surface('a')), getCwd, 50);

    expect(getCwd).not.toHaveBeenCalled();
    expect(refreshed.surfaces[0].cwd).toBeNull();
  });

  it('keeps what it had when the host rejects', async () => {
    const getCwd = vi.fn(async () => { throw new Error('the pty host is gone'); });

    const refreshed = await mirror.refreshMirrorCwds(
      snapshot({ ...surface('a'), cwd: OSC7, terminalId: 'pty-9' }),
      getCwd,
      50,
    );

    expect(refreshed.surfaces[0].cwd).toEqual(OSC7);
  });

  it('gives up at the bound rather than holding the teardown open', async () => {
    // The kill waits behind this on an editor-panel disposal, so a pty host
    // that has stopped answering must not keep the write from happening.
    const never = new Promise<string | null>(() => {});
    const started = Date.now();

    const refreshed = await mirror.refreshMirrorCwds(
      snapshot({ ...surface('a'), terminalId: 'pty-9' }),
      () => never,
      20,
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(refreshed.surfaces[0].cwd).toBeNull();
  });
});
