/**
 * The surface responder: what a webview answers when the Burrow — a service in
 * the process that owns the PTYs — asks what this webview's panes are called
 * and drives them (docs/specs/vscode.md → "Peer surfaces").
 *
 * The asking side lives in the Burrow and is covered by `remote-api.test.ts`
 * against a fake provider. What is only testable here is the registry side:
 * presence-is-ownership, attach-is-the-resize going through the live xterm, and
 * the invalidation that tells the Burrow to re-collect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform, type PlatformAdapter } from '../../lib/platform';
import { setTerminalActivity, clearTerminalActivity } from '../../lib/session-activity-store';
import { createAlertEpisode } from '../../lib/alert-episode';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { clearSizeHold, getSizeHolds, holdSize } from '../../lib/size-hold-store';
import { installPeerSurfaceResponder } from './peer-surfaces';
import { takeBackSize } from './take-back';

interface Responder {
  (params: unknown): unknown[];
}

/** A platform whose `burrow` link stands in for the Burrow service. */
class ServicePlatform {
  readonly responders = new Map<string, Responder>();
  /** How many crossings into the Burrow's process this webview has paid for. */
  notified = 0;
  /** What `status` answers — the gate the notify sources arm on. */
  enrolled = true;
  /** What `status` answers for `serving`: `enrolled`, unless a case sets it. */
  serving: boolean | undefined = undefined;

  /** Every non-`status` command this webview sent, with its params. */
  readonly commands: Array<{ cmd: string; params: unknown }> = [];
  /** What a non-`status` command does: answers, by default, or throws. */
  commandResult: (cmd: string) => unknown = () => undefined;

  readonly burrow = {
    command: async (cmd: string, params?: unknown) => {
      if (cmd === 'status') {
        return { enrolled: this.enrolled, serving: this.serving ?? this.enrolled };
      }
      this.commands.push({ cmd, params });
      return this.commandResult(cmd);
    },
    respond: (op: string, handler: Responder) => {
      this.responders.set(op, handler);
    },
    notify: () => {
      this.notified += 1;
    },
    on: (name: string, listener: (data: unknown) => void) => {
      const named = this.listeners.get(name) ?? new Set();
      this.listeners.set(name, named);
      named.add(listener);
      return () => void named.delete(listener);
    },
  };

  /** The webview's `burrow:event` listeners, by event name. */
  readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  /** One `burrow:event` from the service. */
  emit(data: { name: string } & Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(data.name) ?? [])]) listener(data);
  }

  answer(op: string, params: unknown): unknown[] {
    const handler = this.responders.get(op);
    if (!handler) throw new Error(`nothing responds to ${op}`);
    return handler(params);
  }

  asAdapter(): PlatformAdapter {
    return this as unknown as PlatformAdapter;
  }
}

/** A pane in this webview's registry, with a terminal that records resizes. */
function registerSurface(surfaceId: string, cols = 80, rows = 24) {
  const terminal = {
    cols,
    rows,
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    }),
  };
  registry.set(surfaceId, { terminal } as unknown as TerminalEntry);
  return terminal;
}

let platform: ServicePlatform;

/** The `status` seed is a round trip; the notify sources arm when it lands. */
async function armed(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  platform = new ServicePlatform();
  setPlatform(platform.asAdapter());
  installPeerSurfaceResponder();
});

afterEach(() => {
  for (const id of registry.keys()) clearSizeHold(id);
  clearSizeHold('surface-1');
  clearSizeHold('surface-2');
  registry.clear();
  clearTerminalActivity();
  setPlatform(new FakePtyAdapter());
});

describe('surface responder', () => {
  it('answers with nothing for a surface this webview does not own', () => {
    // Presence *is* ownership: every webview answers, and only the owner's
    // answer is non-empty, so nobody has to say "not mine".
    expect(platform.answer('surfaceOp', { surfaceId: 'elsewhere', op: 'attach' })).toEqual([]);
  });

  it('denies helper discovery and direct attachment until promotion', () => {
    const terminal = registerSurface('helper');
    registry.get('helper')!.helper = { parentId: 'parent', command: 'git status' };
    expect(platform.answer('directory', {})).toEqual([]);
    expect(platform.answer('surfaceOp', { surfaceId: 'helper', op: 'attach', cols: 100, rows: 30 })).toEqual([]);
    expect(terminal.resize).not.toHaveBeenCalled();
    registry.get('helper')!.helper = undefined;
    expect(platform.answer('surfaceOp', { surfaceId: 'helper', op: 'resolve' })).toEqual([{ ptyId: 'helper', cols: 80, rows: 24 }]);
  });

  it('resolves ownership without resizing the live xterm', () => {
    const terminal = registerSurface('surface-1');

    expect(platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'resolve', cols: 100, rows: 30,
    })).toEqual([{ ptyId: 'surface-1', cols: 80, rows: 24 }]);
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  it('resizes the live xterm on attach and reports what it settled at', () => {
    const terminal = registerSurface('surface-1');

    const results = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'attach', cols: 100, rows: 30,
    });

    // Through the xterm, not the PTY: otherwise the owning pane's own view
    // drifts from the size the phone set.
    expect(terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(results).toEqual([{ ptyId: 'surface-1', cols: 100, rows: 30 }]);
  });

  it('treats a later resize exactly like the attach', () => {
    const terminal = registerSurface('surface-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 100, rows: 30 });

    const results = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'resize', cols: 120, rows: 40,
    });

    expect(terminal.resize).toHaveBeenLastCalledWith(120, 40);
    expect(results).toEqual([{ ptyId: 'surface-1', cols: 120, rows: 40 }]);
  });

  it('clamps a size the client asked for, and keeps the current one when it asks for none', () => {
    const terminal = registerSurface('surface-1', 80, 24);

    expect(platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach' })).toEqual([
      { ptyId: 'surface-1', cols: 80, rows: 24 },
    ]);
    expect(terminal.resize).not.toHaveBeenCalled();

    const clamped = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'resize', cols: 0, rows: -5,
    }) as Array<{ cols: number; rows: number }>;
    expect(clamped[0]!.cols).toBeGreaterThan(0);
    expect(clamped[0]!.rows).toBeGreaterThan(0);
  });

  it('answers the directory with this webview snapshot', () => {
    registerSurface('surface-1');
    const entries = platform.answer('directory', {}) as Array<{ surfaceId: string }>;
    expect(entries.map((entry) => entry.surfaceId)).toEqual(['surface-1']);
  });

  it('tells the Burrow when a future directory answer could differ', async () => {
    // The Burrow has no view of the activity store, so a ring that changes an
    // entry is only visible to it if this webview says so.
    await armed();
    setTerminalActivity('pty-1', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await Promise.resolve();
    expect(platform.notified).toBe(1);
  });

  it('coalesces a burst of changes into one crossing', async () => {
    // A focus move alone is two events, and a pane-state change usually lands
    // with an activity change. The Burrow re-collects the whole directory either
    // way, so the burst is worth exactly one notify.
    await armed();
    setTerminalActivity('pty-1', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    setTerminalActivity('pty-2', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    expect(platform.notified).toBe(0);

    await Promise.resolve();
    expect(platform.notified).toBe(1);

    // And the next burst is announced on its own.
    setTerminalActivity('pty-3', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await Promise.resolve();
    expect(platform.notified).toBe(2);
  });

  it('installs its announcing half once, however often it is called', async () => {
    // `RemotePairingModalHost` mounts twice under StrictMode. A second install
    // adds a second set of pane-state, activity, and focus listeners with no
    // handle left to remove them, so every change would cross into the Burrow's
    // process twice for the rest of the session.
    installPeerSurfaceResponder();
    installPeerSurfaceResponder();
    await armed();

    setTerminalActivity('pty-1', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await Promise.resolve();
    expect(platform.notified).toBe(1);
    // And answering still works after the extra calls.
    registerSurface('surface-1');
    expect(platform.answer('directory', {})).toHaveLength(1);
  });

  it('announces while a one-time connection serves, with no enrollment', async () => {
    // A one-time phone reaches these terminals through the same directory, so
    // `serving` arms the announcements, not `enrolled`.
    const oneTime = new ServicePlatform();
    oneTime.enrolled = false;
    oneTime.serving = true;
    setPlatform(oneTime.asAdapter());
    installPeerSurfaceResponder();
    await armed();

    setTerminalActivity('pty-3', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await Promise.resolve();
    expect(oneTime.notified).toBe(1);
  });

  it('announces nothing until there is a Burrow to hear it', async () => {
    // A machine that never enrolled pays no crossing per activity change,
    // which is most machines most of the time.
    platform.enrolled = false;
    const quiet = new ServicePlatform();
    quiet.enrolled = false;
    setPlatform(quiet.asAdapter());
    installPeerSurfaceResponder();
    await armed();

    setTerminalActivity('pty-2', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await Promise.resolve();
    expect(quiet.notified).toBe(0);
    // Answering still works: it costs nothing until the Burrow asks.
    registerSurface('surface-2', 'pty-2');
    expect(quiet.answer('directory', {})).toHaveLength(1);
  });
});

describe('size holds', () => {
  const PHONE = { holder: 'session-a', label: 'iPhone', lease: '1', serviceId: 'service-1' };
  /** A hold as the pane records it: as the Burrow named it, with the size it set. */
  const held = <T extends object>(hold: T, cols: number, rows: number) => ({ ...hold, cols, rows });

  it('records the hold an attach or a resize names, before the size moves', () => {
    const terminal = registerSurface('surface-1');
    const heldAtResize: unknown[] = [];
    terminal.resize.mockImplementation((cols: number, rows: number) => {
      // The pane must already be held when the xterm resizes, or its own fit
      // could answer the resize event with the box's size.
      heldAtResize.push([...getSizeHolds('surface-1')]);
      terminal.cols = cols;
      terminal.rows = rows;
    });
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: PHONE });
    expect(terminal.resize).toHaveBeenCalledWith(51, 14);
    const phone = held(PHONE, 51, 14);
    expect(getSizeHolds('surface-1')).toEqual([phone]);

    const later = { holder: 'session-b', label: 'Pixel', lease: '4', serviceId: 'service-1' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'resize', cols: 40, rows: 20, hold: later });
    expect(getSizeHolds('surface-1')).toEqual([phone, held(later, 40, 20)]);
    expect(heldAtResize).toEqual([[phone], [phone, held(later, 40, 20)]]);
  });

  it('holds even at the size the pane already has', () => {
    registerSurface('surface-1', 80, 24);
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 80, rows: 24, hold: PHONE });
    expect(getSizeHolds('surface-1')).toEqual([held(PHONE, 80, 24)]);
  });

  it('never holds on a resolve, and sizes without holding for a Burrow that names none', () => {
    const terminal = registerSurface('surface-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'resolve', hold: PHONE });
    expect(getSizeHolds('surface-1')).toEqual([]);

    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14 });
    expect(terminal.resize).toHaveBeenCalledWith(51, 14);
    expect(getSizeHolds('surface-1')).toEqual([]);
    // Nor from a hold of the wrong shape: a peer window is another build.
    for (const hold of [
      { holder: 'a', label: 7, lease: '1', serviceId: 's' },
      { holder: 'a', label: 'iPhone', serviceId: 's' },
      { label: 'iPhone', lease: '1', serviceId: 's' },
    ]) {
      platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold });
      expect(getSizeHolds('surface-1')).toEqual([]);
    }
  });

  it('releases only the hold it names — the same session and the same attachment', () => {
    registerSurface('surface-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: PHONE });

    // Another session, and this session's earlier attachment, free nothing.
    for (const other of [{ ...PHONE, holder: 'session-b' }, { ...PHONE, lease: '0' }]) {
      expect(platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: other })).toEqual([]);
      expect(getSizeHolds('surface-1')).toEqual([held(PHONE, 51, 14)]);
    }
    expect(platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: PHONE })).toEqual([]);
    expect(getSizeHolds('surface-1')).toEqual([]);
  });

  it('keeps each holder’s hold until that holder releases it', () => {
    registerSurface('surface-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: PHONE });
    const later = { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-1' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 40, rows: 20, hold: later });

    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: later });
    expect(getSizeHolds('surface-1')).toEqual([held(PHONE, 51, 14)]);
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 40, rows: 20, hold: later });
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: PHONE });
    expect(getSizeHolds('surface-1')).toEqual([held(later, 40, 20)]);
  });

  it('gives the pane back to the size of the holder that remains when the newest lets go', () => {
    const terminal = registerSurface('surface-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: PHONE });
    // The size that holder last set, not the one it attached at.
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'resize', cols: 60, rows: 30, hold: PHONE });
    const later = { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-1' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 40, rows: 20, hold: later });
    expect(terminal).toMatchObject({ cols: 40, rows: 20 });

    // The strip now names the iPhone, and the pane stands at its size.
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: later });
    expect(getSizeHolds('surface-1')).toEqual([held(PHONE, 60, 30)]);
    expect(terminal).toMatchObject({ cols: 60, rows: 30 });

    // The last one leaves the pane to re-fit its own box (`TerminalPane`).
    const resizes = terminal.resize.mock.calls.length;
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'release', hold: PHONE });
    expect(terminal.resize).toHaveBeenCalledTimes(resizes);
  });

  it('gives the pane back to the remaining holder when the dropped instance held it last', () => {
    const terminal = registerSurface('surface-1');
    const current = { ...PHONE, serviceId: 'service-2' };
    const gone = { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-1' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: current });
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 40, rows: 20, hold: gone });

    platform.emit({ name: 'status', enrolled: false, serving: true, serviceId: 'service-2' });
    expect(getSizeHolds('surface-1')).toEqual([held(current, 51, 14)]);
    expect(terminal).toMatchObject({ cols: 51, rows: 14 });
  });

  it('changes nothing and claims nothing for an op this build does not know', () => {
    const terminal = registerSurface('surface-1');
    const phone = held(PHONE, 80, 24);
    holdSize('surface-1', phone);
    expect(platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'teleport', cols: 10, rows: 5, hold: { ...PHONE, holder: 'x' },
    })).toEqual([]);
    expect(terminal.resize).not.toHaveBeenCalled();
    expect(getSizeHolds('surface-1')).toEqual([phone]);
  });

  it('takes a pane back by asking the Burrow to end its holder, then clears the hold', async () => {
    registerSurface('surface-1');
    holdSize('surface-1', held(PHONE, 80, 24));
    platform.commandResult = () => ({ ended: true });

    await takeBackSize('surface-1');
    expect(platform.commands).toEqual([{ cmd: 'takeBack', params: { holder: 'session-a' } }]);
    expect(getSizeHolds('surface-1')).toEqual([]);
  });

  it('takes a pane back from every session holding it', async () => {
    registerSurface('surface-1');
    holdSize('surface-1', held(PHONE, 80, 24));
    holdSize('surface-1', { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-1', cols: 80, rows: 24 });
    platform.commandResult = () => ({ ended: true });

    await takeBackSize('surface-1');
    expect(platform.commands).toEqual([
      { cmd: 'takeBack', params: { holder: 'session-a' } },
      { cmd: 'takeBack', params: { holder: 'session-b' } },
    ]);
    expect(getSizeHolds('surface-1')).toEqual([]);
  });

  it('clears a hold whose holder the Burrow cannot end, and leaves a newer one', async () => {
    registerSurface('surface-1');
    holdSize('surface-1', held(PHONE, 80, 24));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    platform.commandResult = () => {
      throw new Error('no Burrow is reachable');
    };
    await takeBackSize('surface-1');
    expect(getSizeHolds('surface-1')).toEqual([]);

    // A newer holder that arrived while the command was in flight keeps the pane.
    holdSize('surface-1', held(PHONE, 80, 24));
    const later = { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-1', cols: 80, rows: 24 };
    platform.commandResult = () => {
      holdSize('surface-1', later);
      return { ended: true };
    };
    await takeBackSize('surface-1');
    expect(getSizeHolds('surface-1')).toEqual([later]);
  });

  it('drops the holds of a service instance once another one speaks, and keeps the rest', async () => {
    registerSurface('surface-1');
    registerSurface('surface-2');
    const gone = { ...PHONE, serviceId: 'service-1' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: gone });
    platform.answer('surfaceOp', { surfaceId: 'surface-2', op: 'attach', cols: 51, rows: 14, hold: gone });

    // The service that took them is still the one speaking: nothing is dropped.
    platform.emit({ name: 'status', enrolled: true, serving: true, serviceId: 'service-1' });
    expect(getSizeHolds('surface-1')).toEqual([held(gone, 51, 14)]);
    expect(getSizeHolds('surface-2')).toEqual([held(gone, 51, 14)]);

    platform.emit({ name: 'status', enrolled: false, serving: true, serviceId: 'service-2' });
    expect(getSizeHolds('surface-1')).toEqual([]);
    expect(getSizeHolds('surface-2')).toEqual([]);

    // What the new instance's sessions take, it keeps.
    const current = { holder: 'session-b', label: 'Pixel', lease: '1', serviceId: 'service-2' };
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 40, rows: 20, hold: current });
    platform.emit({ name: 'status', enrolled: false, serving: true, serviceId: 'service-2' });
    expect(getSizeHolds('surface-1')).toEqual([held(current, 40, 20)]);
  });

  it('sizes without holding for a hold that names no service instance', () => {
    const terminal = registerSurface('surface-1');
    for (const serviceId of [7, undefined]) {
      platform.answer('surfaceOp', {
        surfaceId: 'surface-1', op: 'attach', cols: 51, rows: 14, hold: { ...PHONE, serviceId },
      });
      expect(getSizeHolds('surface-1')).toEqual([]);
    }
    expect(terminal.resize).toHaveBeenCalledWith(51, 14);
  });

  it('sends nothing for a pane nobody holds', async () => {
    registerSurface('surface-1');
    await takeBackSize('surface-1');
    expect(platform.commands).toEqual([]);
  });
});
