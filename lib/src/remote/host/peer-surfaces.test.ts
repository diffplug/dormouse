/**
 * The surface responder: what a webview answers when the Host — a service in
 * the process that owns the PTYs — asks what this webview's panes are called
 * and drives them (docs/specs/vscode.md → "Peer surfaces").
 *
 * The asking side lives in the Host and is covered by `remote-api.test.ts`
 * against a fake provider. What is only testable here is the registry side:
 * presence-is-ownership, attach-is-the-resize going through the live xterm, and
 * the invalidation that tells the Host to re-collect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform, type PlatformAdapter } from '../../lib/platform';
import { primeActivity, clearPrimedActivity } from '../../lib/session-activity-store';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { installPeerSurfaceResponder } from './peer-surfaces';

interface Responder {
  (params: unknown): unknown[];
}

/** A platform whose `remoteHost` link stands in for the Host service. */
class ServicePlatform {
  readonly responders = new Map<string, Responder>();
  readonly notified: string[] = [];

  readonly remoteHost = {
    command: async () => undefined,
    respond: (op: string, handler: Responder) => {
      this.responders.set(op, handler);
    },
    notify: (topic: string) => void this.notified.push(topic),
    on: () => () => {},
  };

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
function registerSurface(surfaceId: string, ptyId: string, cols = 80, rows = 24) {
  const terminal = {
    cols,
    rows,
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    }),
  };
  registry.set(surfaceId, { ptyId, terminal } as unknown as TerminalEntry);
  return terminal;
}

let platform: ServicePlatform;

beforeEach(() => {
  platform = new ServicePlatform();
  setPlatform(platform.asAdapter());
  installPeerSurfaceResponder();
});

afterEach(() => {
  registry.clear();
  clearPrimedActivity();
  setPlatform(new FakePtyAdapter());
});

describe('surface responder', () => {
  it('answers with nothing for a surface this webview does not own', () => {
    // Presence *is* ownership: every webview answers, and only the owner's
    // answer is non-empty, so nobody has to say "not mine".
    expect(platform.answer('surfaceOp', { surfaceId: 'elsewhere', op: 'attach' })).toEqual([]);
  });

  it('resizes the live xterm on attach and reports what it settled at', () => {
    const terminal = registerSurface('surface-1', 'pty-1');

    const results = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'attach', cols: 100, rows: 30,
    });

    // Through the xterm, not the PTY: otherwise the owning pane's own view
    // drifts from the size the phone set.
    expect(terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(results).toEqual([{ ptyId: 'pty-1', cols: 100, rows: 30 }]);
  });

  it('treats a later resize exactly like the attach', () => {
    const terminal = registerSurface('surface-1', 'pty-1');
    platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach', cols: 100, rows: 30 });

    const results = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'resize', cols: 120, rows: 40,
    });

    expect(terminal.resize).toHaveBeenLastCalledWith(120, 40);
    expect(results).toEqual([{ ptyId: 'pty-1', cols: 120, rows: 40 }]);
  });

  it('clamps a size the client asked for, and keeps the current one when it asks for none', () => {
    const terminal = registerSurface('surface-1', 'pty-1', 80, 24);

    expect(platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'attach' })).toEqual([
      { ptyId: 'pty-1', cols: 80, rows: 24 },
    ]);
    expect(terminal.resize).not.toHaveBeenCalled();

    const clamped = platform.answer('surfaceOp', {
      surfaceId: 'surface-1', op: 'resize', cols: 0, rows: -5,
    }) as Array<{ cols: number; rows: number }>;
    expect(clamped[0]!.cols).toBeGreaterThan(0);
    expect(clamped[0]!.rows).toBeGreaterThan(0);
  });

  it('leaves the pane alone on detach', () => {
    // Last-attach-wins: the Host stops streaming on its side and the pane keeps
    // whatever size it was left at.
    const terminal = registerSurface('surface-1', 'pty-1', 90, 25);

    expect(platform.answer('surfaceOp', { surfaceId: 'surface-1', op: 'detach' })).toEqual([
      { ptyId: 'pty-1', cols: 90, rows: 25 },
    ]);
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  it('answers the directory with this webview snapshot', () => {
    registerSurface('surface-1', 'pty-1');
    const entries = platform.answer('directory', {}) as Array<{ surfaceId: string }>;
    expect(entries.map((entry) => entry.surfaceId)).toEqual(['surface-1']);
  });

  it('tells the Host when a future directory answer could differ', () => {
    // The Host has no view of the activity store, so a ring that changes an
    // entry is only visible to it if this webview says so.
    primeActivity('pty-1', { status: 'ALERT_RINGING' });
    expect(platform.notified).toContain('directory');
  });
});
