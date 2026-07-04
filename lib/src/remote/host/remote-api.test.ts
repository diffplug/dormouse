import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type RemoteEventMsg,
  type RemoteResponse,
} from 'server-lib-common';
import { FakePtyAdapter, setPlatform, type PlatformAdapter } from '../../lib/platform';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { RemoteApiSession } from './remote-api';

type SentPayload = RemoteResponse | RemoteEventMsg;
type DataHandler = (detail: { id: string; data: string }) => void;
type ExitHandler = (detail: { id: string; exitCode: number }) => void;

class RepaintOnResizePlatform {
  readonly dataHandlers = new Set<DataHandler>();
  readonly exitHandlers = new Set<ExitHandler>();
  readonly resizePty = vi.fn((id: string, cols: number, rows: number) => {
    this.emitData(id, `pty-resize:${cols}x${rows}`);
  });
  readonly writePty = vi.fn();

  onPtyData(handler: DataHandler): void {
    this.dataHandlers.add(handler);
  }

  offPtyData(handler: DataHandler): void {
    this.dataHandlers.delete(handler);
  }

  onPtyExit(handler: ExitHandler): void {
    this.exitHandlers.add(handler);
  }

  offPtyExit(handler: ExitHandler): void {
    this.exitHandlers.delete(handler);
  }

  emitData(id: string, data: string): void {
    for (const handler of this.dataHandlers) {
      handler({ id, data });
    }
  }

  emitExit(id: string, exitCode: number): void {
    for (const handler of this.exitHandlers) {
      handler({ id, exitCode });
    }
  }

  asAdapter(): PlatformAdapter {
    return this as unknown as PlatformAdapter;
  }
}

function registerSurface(
  platform: RepaintOnResizePlatform,
  cols: number,
  rows: number,
  surfaceId = 'surface-1',
  ptyId = 'pty-1',
): void {
  const terminal = {
    cols,
    rows,
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
      platform.emitData(ptyId, `terminal-resize:${nextCols}x${nextRows}`);
    }),
  };

  registry.set(surfaceId, {
    ptyId,
    terminal,
  } as unknown as TerminalEntry);
}

function attach(session: RemoteApiSession, cols: number, rows: number, surfaceId = 'surface-1'): void {
  session.handle({
    requestId: 'attach-1',
    method: REMOTE_METHODS.surfaceAttach,
    params: { surfaceId, cols, rows },
  });
}

function decodeTerminalData(payload: SentPayload): string {
  const event = payload as RemoteEventMsg;
  return utf8Decode(fromBase64Url((event.data as { bytes: string }).bytes));
}

describe('RemoteApiSession surface.attach', () => {
  afterEach(() => {
    vi.useRealTimers();
    registry.clear();
    setPlatform(new FakePtyAdapter());
  });

  it('keeps synchronous repaint data from terminal resize', () => {
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24);
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 100, 30);

    expect(sent[0]).toMatchObject({
      requestId: 'attach-1',
      ok: true,
      result: { cols: 100, rows: 30 },
    });
    expect(sent[1]).toMatchObject({
      subId: 'attach-1',
      event: REMOTE_EVENTS.terminalData,
    });
    expect(decodeTerminalData(sent[1]!)).toBe('terminal-resize:100x30');
  });

  it('keeps synchronous repaint data from the same-size PTY bounce', () => {
    vi.useFakeTimers();
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24);
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 80, 24);

    expect(platform.resizePty).toHaveBeenNthCalledWith(1, 'pty-1', 80, 23);
    expect(sent[0]).toMatchObject({
      requestId: 'attach-1',
      ok: true,
      result: { cols: 80, rows: 24 },
    });
    expect(sent[1]).toMatchObject({
      subId: 'attach-1',
      event: REMOTE_EVENTS.terminalData,
    });
    expect(decodeTerminalData(sent[1]!)).toBe('pty-resize:80x23');

    vi.advanceTimersByTime(60);
    expect(platform.resizePty).toHaveBeenNthCalledWith(2, 'pty-1', 80, 24);
  });

  it('does not fire the same-size bounce restore after detaching', () => {
    vi.useFakeTimers();
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24);
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 80, 24);

    // The synchronous bounce away from `rows` has fired; the restore is pending.
    expect(platform.resizePty).toHaveBeenNthCalledWith(1, 'pty-1', 80, 23);
    expect(platform.resizePty).toHaveBeenCalledTimes(1);

    // Detach inside the ~60ms window, before the restore fires.
    session.handle({
      requestId: 'detach',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });

    vi.advanceTimersByTime(60);

    // The stale restore must never touch the now-detached PTY.
    expect(platform.resizePty).toHaveBeenCalledTimes(1);
    expect(platform.resizePty).not.toHaveBeenCalledWith('pty-1', 80, 24);
  });

  it('does not let a stale bounce restore clobber a newer attachment', () => {
    vi.useFakeTimers();
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24, 'surface-1', 'pty-1');
    registerSurface(platform, 80, 24, 'surface-2', 'pty-2');
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    // First attach schedules a restore bounce for pty-1.
    attach(session, 80, 24, 'surface-1');
    expect(platform.resizePty).toHaveBeenNthCalledWith(1, 'pty-1', 80, 23);

    // Re-attaching to a different surface replaces the attachment (last-attach-wins)
    // and must cancel the prior pty-1 restore.
    attach(session, 80, 24, 'surface-2');
    expect(platform.resizePty).toHaveBeenNthCalledWith(2, 'pty-2', 80, 23);

    vi.advanceTimersByTime(60);

    // Only the current attachment's restore fires; pty-1's stale restore does not.
    expect(platform.resizePty).toHaveBeenNthCalledWith(3, 'pty-2', 80, 24);
    expect(platform.resizePty).toHaveBeenCalledTimes(3);
    expect(platform.resizePty).not.toHaveBeenCalledWith('pty-1', 80, 24);
  });

  it('rejects write and resize unless the surface is the current attachment', () => {
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24, 'surface-1', 'pty-1');
    registerSurface(platform, 100, 30, 'surface-2', 'pty-2');
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 80, 24, 'surface-1');
    sent.length = 0;

    session.handle({
      requestId: 'write-background',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-2', bytes: toBase64Url(utf8Encode('invisible\r')) },
    });
    session.handle({
      requestId: 'resize-background',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-2', cols: 120, rows: 40 },
    });

    expect(platform.writePty).not.toHaveBeenCalled();
    expect((registry.get('surface-2')!.terminal as { cols: number; rows: number }).cols).toBe(100);
    expect(sent).toEqual([
      {
        requestId: 'write-background',
        ok: false,
        error: 'surface is not attached: surface-2',
      },
      {
        requestId: 'resize-background',
        ok: false,
        error: 'surface is not attached: surface-2',
      },
    ]);

    session.handle({
      requestId: 'detach',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });
    sent.length = 0;

    session.handle({
      requestId: 'write-detached',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode('stale\r')) },
    });

    expect(platform.writePty).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        requestId: 'write-detached',
        ok: false,
        error: 'surface is not attached: surface-1',
      },
    ]);
  });

  it('keeps write and resize pinned to the attached terminal after pane swaps', () => {
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24, 'surface-1', 'pty-1');
    registerSurface(platform, 100, 30, 'surface-2', 'pty-2');
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 90, 25, 'surface-1');
    const attachedEntry = registry.get('surface-1')!;
    const swappedInEntry = registry.get('surface-2')!;
    registry.set('surface-1', swappedInEntry);
    registry.set('surface-2', attachedEntry);
    sent.length = 0;

    session.handle({
      requestId: 'write-after-swap',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode('still-attached\r')) },
    });

    expect(platform.writePty).toHaveBeenCalledWith('pty-1', 'still-attached\r');
    expect(platform.writePty).not.toHaveBeenCalledWith('pty-2', expect.any(String));

    session.handle({
      requestId: 'resize-after-swap',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', cols: 120, rows: 40 },
    });

    expect((attachedEntry.terminal as { cols: number; rows: number }).cols).toBe(120);
    expect((attachedEntry.terminal as { cols: number; rows: number }).rows).toBe(40);
    expect((swappedInEntry.terminal as { cols: number; rows: number }).cols).toBe(100);
    expect((swappedInEntry.terminal as { cols: number; rows: number }).rows).toBe(30);
    expect(sent).toEqual([
      {
        requestId: 'write-after-swap',
        ok: true,
        result: {},
      },
      {
        subId: 'attach-1',
        event: REMOTE_EVENTS.terminalData,
        data: { bytes: toBase64Url(utf8Encode('terminal-resize:120x40')) },
      },
      {
        requestId: 'resize-after-swap',
        ok: true,
        result: { cols: 120, rows: 40 },
      },
    ]);
  });

  it('tears down the attachment when the attached PTY exits', () => {
    const platform = new RepaintOnResizePlatform();
    setPlatform(platform.asAdapter());
    registerSurface(platform, 80, 24, 'surface-1', 'pty-1');
    const sent: SentPayload[] = [];
    const session = new RemoteApiSession({ hostId: 'host-1', send: (payload) => sent.push(payload) });

    attach(session, 100, 30, 'surface-1');
    sent.length = 0;

    // The attached PTY exits (process death, or the pane disposed on the Host).
    platform.emitExit('pty-1', 0);

    // The client is told the terminal closed...
    expect(sent).toEqual([
      {
        subId: 'attach-1',
        event: REMOTE_EVENTS.terminalClosed,
        data: { exitCode: 0 },
      },
    ]);
    sent.length = 0;

    // ...and the attachment is gone, so a later write/resize for that surface
    // fails safe instead of touching the dead PTY / disposed xterm.
    session.handle({
      requestId: 'write-after-exit',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode('ghost\r')) },
    });
    session.handle({
      requestId: 'resize-after-exit',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', cols: 120, rows: 40 },
    });

    expect(platform.writePty).not.toHaveBeenCalled();
    expect(platform.resizePty).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        requestId: 'write-after-exit',
        ok: false,
        error: 'surface is not attached: surface-1',
      },
      {
        requestId: 'resize-after-exit',
        ok: false,
        error: 'surface is not attached: surface-1',
      },
    ]);
  });
});
