import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  fromBase64Url,
  utf8Decode,
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

  writePty(): void {}

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

  asAdapter(): PlatformAdapter {
    return this as unknown as PlatformAdapter;
  }
}

function registerSurface(platform: RepaintOnResizePlatform, cols: number, rows: number): void {
  const ptyId = 'pty-1';
  const terminal = {
    cols,
    rows,
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
      platform.emitData(ptyId, `terminal-resize:${nextCols}x${nextRows}`);
    }),
  };

  registry.set('surface-1', {
    ptyId,
    terminal,
  } as unknown as TerminalEntry);
}

function attach(session: RemoteApiSession, cols: number, rows: number): void {
  session.handle({
    requestId: 'attach-1',
    method: REMOTE_METHODS.surfaceAttach,
    params: { surfaceId: 'surface-1', cols, rows },
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
});
