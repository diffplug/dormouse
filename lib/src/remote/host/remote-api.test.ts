/**
 * The remote-api session against a fake {@link HostSurfaceProvider}. Everything
 * below the protocol — registry, platform adapter, peer round trips — is the
 * provider's problem, so these tests are about the protocol only: what the
 * client is answered, in what order, and which provider calls a request turns
 * into. The webview-backed provider itself is covered by `peer-surfaces.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type DirectoryEntry,
  type RemoteEventMsg,
  type RemoteResponse,
} from 'remote-lib-common';
import type { HostSurfaceProvider, PtySink, SurfaceHandle } from './host-surface-provider';
import { RemoteApiSession } from './remote-api';

type SentPayload = RemoteResponse | RemoteEventMsg;

/** A surface the fake owns, standing in for a live xterm at a known size. */
interface FakeSurface {
  ptyId: string;
  cols: number;
  rows: number;
}

/**
 * A provider whose PTYs repaint on every resize, the way a real one does: that
 * repaint is the only thing that fills the client's screen (attach-is-the-resize),
 * so its timing relative to the attach response is load-bearing.
 */
class FakeProvider implements HostSurfaceProvider {
  readonly surfaces = new Map<string, FakeSurface>();

  /** `resizePty` — the PTY-only path used by the same-size repaint bounce. */
  readonly ptyResizes: Array<[string, number, number]> = [];
  /** `handle.resize` — the through-the-owner path an attach/resize takes. */
  readonly handleResizes: Array<[string, number, number]> = [];
  readonly writes: Array<[string, string]> = [];
  readonly released: string[] = [];
  readonly streamed: string[] = [];
  readonly unstreamed: string[] = [];
  readonly resolved: string[] = [];

  entries: DirectoryEntry[] = [];
  collects = 0;
  watchers = 0;
  collectError: Error | null = null;
  resolveError: Error | null = null;
  resizeError: Error | null = null;

  /** Hold every resolve open, the way an owner a round trip away would. */
  resolveGate: Promise<void> | null = null;
  /** Hold every directory collect open. */
  collectGate: Promise<void> | null = null;
  /** Hold every `handle.resize` open — the deferred half of an attach. */
  resizeGate: Promise<void> | null = null;
  /** Hold stream readiness, as a cross-window subscribe acknowledgement does. */
  streamReadyGate: Promise<void> | null = null;

  readonly #sinks = new Map<string, Set<PtySink>>();
  readonly #exits = new Map<string, number>();
  readonly #onChange = new Set<() => void>();

  // --- HostSurfaceProvider ---

  collectDirectory = async (): Promise<DirectoryEntry[]> => {
    this.collects += 1;
    await this.collectGate;
    if (this.collectError) throw this.collectError;
    return this.entries;
  };

  watchDirectory = (onChange: () => void): (() => void) => {
    this.watchers += 1;
    this.#onChange.add(onChange);
    return () => {
      this.watchers -= 1;
      this.#onChange.delete(onChange);
    };
  };

  resolveSurface = async (surfaceId: string): Promise<SurfaceHandle | null> => {
    this.resolved.push(surfaceId);
    const surface = this.surfaces.get(surfaceId);
    await this.resolveGate;
    if (this.resolveError) throw this.resolveError;
    return surface ? this.#handleFor(surface) : null;
  };

  writePty = (ptyId: string, data: string): void => {
    this.writes.push([ptyId, data]);
  };

  resizePty = (ptyId: string, cols: number, rows: number): void => {
    this.ptyResizes.push([ptyId, cols, rows]);
    this.emitData(ptyId, `pty-resize:${cols}x${rows}`);
  };

  streamPty = (ptyId: string, sink: PtySink) => {
    this.streamed.push(ptyId);
    let sinks = this.#sinks.get(ptyId);
    if (!sinks) {
      sinks = new Set();
      this.#sinks.set(ptyId, sinks);
    }
    sinks.add(sink);
    const stop = () => {
      this.unstreamed.push(ptyId);
      sinks.delete(sink);
    };
    // The production providers bridge the resolve -> subscribe gap this way:
    // subscription replays an exit that landed before there was a sink.
    if (this.#exits.has(ptyId)) sink.onExit(this.#exits.get(ptyId)!);
    return { stop, ready: this.streamReadyGate ?? Promise.resolve() };
  };

  // --- Test drivers ---

  addSurface(surfaceId: string, ptyId: string, cols = 80, rows = 24): FakeSurface {
    const surface: FakeSurface = { ptyId, cols, rows };
    // A new PTY generation may reuse a pane id; its predecessor's exit does not
    // belong to it.
    this.#exits.delete(ptyId);
    this.surfaces.set(surfaceId, surface);
    return surface;
  }

  /** Only a subscriber hears anything — the per-PTY subscription *is* the filter. */
  emitData(ptyId: string, data: string, textData?: string): void {
    const chunk = textData === undefined ? { data } : { data, textData };
    for (const sink of this.#sinks.get(ptyId) ?? []) sink.onData(chunk);
  }

  emitExit(ptyId: string, exitCode: number): void {
    this.#exits.set(ptyId, exitCode);
    for (const sink of [...(this.#sinks.get(ptyId) ?? [])]) sink.onExit(exitCode);
  }

  /** Whatever the provider watches for changed; the session decides when to re-collect. */
  changeDirectory(): void {
    for (const listener of [...this.#onChange]) listener();
  }

  #handleFor(surface: FakeSurface): SurfaceHandle {
    return {
      ptyId: surface.ptyId,
      // Live, and pinned to this surface object rather than to the id it was
      // found under, so a swap behind the id cannot move the attachment.
      get cols() {
        return surface.cols;
      },
      get rows() {
        return surface.rows;
      },
      resize: async (cols, rows) => {
        this.handleResizes.push([surface.ptyId, cols, rows]);
        // Only when gated: an owner applies the size synchronously and answers
        // a round trip later, which several cases below depend on.
        if (this.resizeGate) await this.resizeGate;
        if (this.resizeError) throw this.resizeError;
        if (surface.cols !== cols || surface.rows !== rows) {
          surface.cols = cols;
          surface.rows = rows;
          this.emitData(surface.ptyId, `terminal-resize:${cols}x${rows}`);
        }
        return { cols: surface.cols, rows: surface.rows };
      },
      release: () => void this.released.push(surface.ptyId),
    };
  }
}

/** Hold every gated round trip open until the returned function is called. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeSession(provider: FakeProvider): { session: RemoteApiSession; sent: SentPayload[] } {
  const sent: SentPayload[] = [];
  const session = new RemoteApiSession({
    hostId: 'host-1',
    send: (payload) => void sent.push(payload),
    provider,
  });
  return { session, sent };
}

/** Let a promise-tailed handler run; microtasks are unaffected by fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * Resolving a surface is a promise — an owner in another webview is a round
 * trip away, and the local path takes the same seam rather than a second one —
 * so an attach lands a microtask later even when nothing is gated.
 */
async function attach(
  session: RemoteApiSession,
  cols: number,
  rows: number,
  surfaceId = 'surface-1',
  requestId = 'attach-1',
): Promise<void> {
  session.handle({
    requestId,
    method: REMOTE_METHODS.surfaceAttach,
    params: { surfaceId, cols, rows },
  });
  await settle();
}

async function watchDirectory(session: RemoteApiSession, requestId = 'dir-1'): Promise<void> {
  session.handle({ requestId, method: REMOTE_METHODS.directoryWatch, params: {} });
  await settle();
}

function decodeTerminalData(payload: SentPayload): string {
  const event = payload as RemoteEventMsg;
  return utf8Decode(fromBase64Url((event.data as { bytes: string }).bytes));
}

function terminalData(sent: SentPayload[]): string[] {
  return sent
    .filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalData)
    .map(decodeTerminalData);
}

function snapshots(sent: SentPayload[]): Array<{ subId: string; entries: DirectoryEntry[] }> {
  return sent
    .filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.directorySnapshot)
    .map((p) => ({
      subId: (p as RemoteEventMsg).subId,
      entries: ((p as RemoteEventMsg).data as { entries: DirectoryEntry[] }).entries,
    }));
}

function entry(surfaceId: string, title: string): DirectoryEntry {
  return {
    paneRef: surfaceId,
    surfaceId,
    type: 'terminal',
    title,
    focused: false,
    alive: true,
    ringing: false,
    hasTODO: false,
  };
}

function reply(sent: SentPayload[], requestId: string): RemoteResponse {
  return sent.find((p) => (p as RemoteResponse).requestId === requestId) as RemoteResponse;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RemoteApiSession hello', () => {
  it('reports protocol v1, the host id, and the flat selfhost grants', () => {
    const { session, sent } = makeSession(new FakeProvider());

    session.handle({ requestId: 'hello-1', method: REMOTE_METHODS.hello, params: {} });

    expect(sent).toEqual([
      {
        requestId: 'hello-1',
        ok: true,
        result: {
          protocolVersion: 1,
          hostId: 'host-1',
          grants: { input: true, layout: false },
        },
      },
    ]);
  });

  it('fails an unknown method rather than dropping it', () => {
    const { session, sent } = makeSession(new FakeProvider());

    session.handle({ requestId: 'x-1', method: 'surface.teleport', params: {} });

    expect(sent).toEqual([
      { requestId: 'x-1', ok: false, error: 'unknown method: surface.teleport' },
    ]);
  });
});

describe('RemoteApiSession directory.watch', () => {
  it('answers with the request id as subId and emits one snapshot per collect', async () => {
    const provider = new FakeProvider();
    provider.entries = [entry('surface-1', 'near'), entry('surface-far', 'far')];
    const { session, sent } = makeSession(provider);

    await watchDirectory(session);

    expect(sent[0]).toEqual({ requestId: 'dir-1', ok: true, result: { subId: 'dir-1' } });
    // One collect, one snapshot: the provider answers for every surface the
    // Host can reach, so there is no partial listing to send ahead of it.
    expect(provider.collects).toBe(1);
    expect(snapshots(sent)).toEqual([
      { subId: 'dir-1', entries: provider.entries },
    ]);
  });

  it('coalesces a burst of changes into one re-snapshot per debounce window', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.entries = [entry('surface-1', 'before')];
    const { session, sent } = makeSession(provider);
    await watchDirectory(session);

    provider.entries = [entry('surface-1', 'after')];
    provider.changeDirectory();
    provider.changeDirectory();
    provider.changeDirectory();

    // Still inside the 150ms window: nothing re-collected yet.
    vi.advanceTimersByTime(149);
    await settle();
    expect(provider.collects).toBe(1);

    vi.advanceTimersByTime(1);
    await settle();
    expect(provider.collects).toBe(2);
    expect(snapshots(sent).map((s) => s.entries)).toEqual([
      [entry('surface-1', 'before')],
      [entry('surface-1', 'after')],
    ]);

    // A later change opens a fresh window rather than riding the spent timer.
    provider.changeDirectory();
    vi.advanceTimersByTime(150);
    await settle();
    expect(provider.collects).toBe(3);
  });

  it('drops a snapshot whose collect resolved after the subscription was replaced', async () => {
    const provider = new FakeProvider();
    provider.entries = [entry('surface-1', 'stale')];
    const slow = gate();
    provider.collectGate = slow.promise;
    const { session, sent } = makeSession(provider);

    await watchDirectory(session, 'dir-1');
    // The client re-watches (a reconnect) before the first collect answers.
    provider.collectGate = null;
    provider.entries = [entry('surface-1', 'fresh')];
    await watchDirectory(session, 'dir-2');
    slow.release();
    await settle();

    // The client correlates by subId, so a snapshot for a subscription it has
    // already replaced would be an answer to a question it stopped asking.
    expect(snapshots(sent)).toEqual([
      { subId: 'dir-2', entries: [entry('surface-1', 'fresh')] },
    ]);
  });

  it('emits only the newest collect when two overlap and settle out of order', async () => {
    // Two collects overlap whenever something changes during a slow round trip,
    // and the near tier can answer long after the far one. Without a generation
    // the older one emits last — and a collect that timed out to an empty
    // answer would blank the phone's picker until the next change.
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.entries = [entry('surface-1', 'first')];
    const { session, sent } = makeSession(provider);
    await watchDirectory(session);
    expect(snapshots(sent)).toHaveLength(1);

    const slow = gate();
    provider.collectGate = slow.promise;
    provider.entries = [];
    provider.changeDirectory();
    vi.advanceTimersByTime(150);
    await settle();
    expect(provider.collects).toBe(2);

    // A second change while the first is still in flight, answered immediately.
    provider.collectGate = null;
    provider.entries = [entry('surface-1', 'newest')];
    provider.changeDirectory();
    vi.advanceTimersByTime(150);
    await settle();

    slow.release();
    await settle();

    expect(snapshots(sent).map((s) => s.entries)).toEqual([
      [entry('surface-1', 'first')],
      [entry('surface-1', 'newest')],
    ]);
  });

  it('watches once across repeated directory.watch requests', async () => {
    const provider = new FakeProvider();
    const { session } = makeSession(provider);

    await watchDirectory(session, 'dir-1');
    await watchDirectory(session, 'dir-2');

    expect(provider.watchers).toBe(1);
  });

  it('stops watching on dispose and drops a snapshot that lands afterwards', async () => {
    const provider = new FakeProvider();
    const slow = gate();
    provider.collectGate = slow.promise;
    const { session, sent } = makeSession(provider);
    await watchDirectory(session);

    session.dispose();
    slow.release();
    await settle();
    provider.changeDirectory();
    await settle();

    expect(provider.watchers).toBe(0);
    expect(snapshots(sent)).toEqual([]);
  });

  it('keeps the last good snapshot and retries after collection rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = new FakeProvider();
    provider.entries = [entry('surface-1', 'before')];
    const { session, sent } = makeSession(provider);
    await watchDirectory(session, 'dir-1');

    provider.collectError = new Error('peer unavailable');
    await watchDirectory(session, 'dir-2');

    expect(snapshots(sent)).toEqual([
      { subId: 'dir-1', entries: [entry('surface-1', 'before')] },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'remote-host: directory collection failed',
      provider.collectError,
    );

    provider.collectError = null;
    provider.entries = [entry('surface-1', 'after')];
    await watchDirectory(session, 'dir-3');

    expect(snapshots(sent)).toEqual([
      { subId: 'dir-1', entries: [entry('surface-1', 'before')] },
      { subId: 'dir-3', entries: [entry('surface-1', 'after')] },
    ]);
  });
});

describe('RemoteApiSession surface.attach', () => {
  it('resizes through the handle and keeps the synchronous repaint data', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30);

    // Attach-is-the-resize goes through the owner, not the PTY.
    expect(provider.handleResizes).toEqual([['pty-1', 100, 30]]);
    expect(provider.ptyResizes).toEqual([]);
    expect(sent[0]).toMatchObject({
      requestId: 'attach-1',
      ok: true,
      result: { cols: 100, rows: 30 },
    });
    // The repaint fires while the attach is still being answered, so it is
    // buffered and flushed after the response — never ahead of it.
    expect(sent[1]).toMatchObject({ subId: 'attach-1', event: REMOTE_EVENTS.terminalData });
    expect(decodeTerminalData(sent[1]!)).toBe('terminal-resize:100x30');
  });

  it('carries the text projection on terminal.data only when it differs', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30);
    sent.length = 0;

    provider.emitData('pty-1', 'plain');
    provider.emitData('pty-1', 'pre\x1b]1337;File=inline=1:AAAA\x07post', 'prepost');
    // Present-and-empty is authoritative: a chunk of nothing but a forwarded
    // image sequence has a text projection, and it is the empty string.
    provider.emitData('pty-1', '\x1b]1337;File=inline=1:AAAA\x07', '');

    expect(sent.map((payload) => (payload as RemoteEventMsg).data)).toEqual([
      { bytes: toBase64Url(utf8Encode('plain')) },
      {
        bytes: toBase64Url(utf8Encode('pre\x1b]1337;File=inline=1:AAAA\x07post')),
        text: toBase64Url(utf8Encode('prepost')),
      },
      {
        bytes: toBase64Url(utf8Encode('\x1b]1337;File=inline=1:AAAA\x07')),
        text: toBase64Url(utf8Encode('')),
      },
    ]);
  });

  it('falls back to the surface size for a missing dimension', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    session.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-1', cols: 120 },
    });
    await settle();

    expect(provider.handleResizes).toEqual([['pty-1', 120, 24]]);
    expect(reply(sent, 'attach-1').result).toEqual({ cols: 120, rows: 24 });
  });

  it('keeps the synchronous repaint data from the same-size PTY bounce', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 80, 24);

    // The size is already right, so the owner is left alone and only the PTY
    // is bounced — that SIGWINCH is the whole point.
    expect(provider.handleResizes).toEqual([]);
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 23]]);
    expect(sent[0]).toMatchObject({
      requestId: 'attach-1',
      ok: true,
      result: { cols: 80, rows: 24 },
    });
    expect(sent[1]).toMatchObject({ subId: 'attach-1', event: REMOTE_EVENTS.terminalData });
    expect(decodeTerminalData(sent[1]!)).toBe('pty-resize:80x23');

    vi.advanceTimersByTime(60);
    expect(provider.ptyResizes).toEqual([
      ['pty-1', 80, 23],
      ['pty-1', 80, 24],
    ]);
  });

  it('bounces a one-row surface upward, where a bounce is not a no-op', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 1);
    const { session } = makeSession(provider);

    await attach(session, 80, 1);

    // rows-1 would be 0 — clamped back to the same size, so no SIGWINCH and no
    // repaint at all.
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 2]]);
    vi.advanceTimersByTime(60);
    expect(provider.ptyResizes.at(-1)).toEqual(['pty-1', 80, 1]);
  });

  it('does not fire the same-size bounce restore after detaching', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session } = makeSession(provider);

    await attach(session, 80, 24);

    // The synchronous bounce away from `rows` has fired; the restore is pending.
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 23]]);

    // Detach inside the ~60ms window, before the restore fires.
    session.handle({
      requestId: 'detach',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });
    vi.advanceTimersByTime(60);

    // The stale restore must never touch the now-detached PTY.
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 23]]);
  });

  it('does not let a stale bounce restore clobber a newer attachment', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    provider.addSurface('surface-2', 'pty-2', 80, 24);
    const { session } = makeSession(provider);

    // First attach schedules a restore bounce for pty-1.
    await attach(session, 80, 24, 'surface-1');
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 23]]);

    // Re-attaching to a different surface replaces the attachment
    // (last-attach-wins) and must cancel the prior pty-1 restore.
    await attach(session, 80, 24, 'surface-2', 'attach-2');
    expect(provider.ptyResizes.at(-1)).toEqual(['pty-2', 80, 23]);

    vi.advanceTimersByTime(60);

    // Only the current attachment's restore fires.
    expect(provider.ptyResizes).toEqual([
      ['pty-1', 80, 23],
      ['pty-2', 80, 23],
      ['pty-2', 80, 24],
    ]);
  });

  it('replaces the previous attachment, unsubscribing its stream and releasing it', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    provider.addSurface('surface-2', 'pty-2', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30, 'surface-1');
    await attach(session, 100, 30, 'surface-2', 'attach-2');
    sent.length = 0;
    provider.emitData('pty-1', 'from the old attachment');

    expect(provider.streamed).toEqual(['pty-1', 'pty-2']);
    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
    expect(terminalData(sent)).toEqual([]);
  });

  it('fails an attach for a surface nobody owns', async () => {
    const provider = new FakeProvider();
    const { session, sent } = makeSession(provider);

    await attach(session, 80, 24, 'nobody');

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'no such surface: nobody',
    });
    expect(provider.streamed).toEqual([]);
  });

  it('fails an attach when its owner cannot resolve the surface', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    provider.resolveError = new Error('owner unavailable');
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30);

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'surface attach failed: owner unavailable',
    });
    expect(provider.streamed).toEqual([]);
    expect(provider.released).toEqual([]);
  });

  it('fails and unwinds an attach whose resize is rejected', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    provider.resizeError = new Error('owner unavailable');
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30);

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'surface attach failed: owner unavailable',
    });
    expect(provider.streamed).toEqual(['pty-1']);
    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
  });

  it('fails an attach with no surfaceId without asking the provider', async () => {
    const provider = new FakeProvider();
    const { session, sent } = makeSession(provider);

    session.handle({ requestId: 'attach-1', method: REMOTE_METHODS.surfaceAttach, params: {} });
    await settle();

    expect(sent).toEqual([
      { requestId: 'attach-1', ok: false, error: 'no such surface: (none)' },
    ]);
    expect(provider.resolved).toEqual([]);
  });

  it('fails a superseded attach and releases the handle it resolved late', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-slow', 'pty-slow', 80, 24);
    provider.addSurface('surface-fast', 'pty-fast', 80, 24);
    const slow = gate();
    provider.resolveGate = slow.promise;
    const { session, sent } = makeSession(provider);

    // The client attaches one pane and switches to another before the first
    // owner answers, so the two resolves land out of order.
    session.handle({
      requestId: 'attach-slow',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-slow', cols: 80, rows: 24 },
    });
    provider.resolveGate = null;
    await attach(session, 100, 30, 'surface-fast', 'attach-fast');
    slow.release();
    await settle();

    // The superseded attach unwinds the handle it resolved instead of tearing
    // down the newer attachment...
    expect(provider.released).toEqual(['pty-slow']);
    expect(provider.streamed).toEqual(['pty-fast']);
    // ...and is answered, because the client holds a request pending until it is.
    expect(reply(sent, 'attach-fast').ok).toBe(true);
    expect(reply(sent, 'attach-slow').ok).toBe(false);
    expect(reply(sent, 'attach-slow').error).toMatch(/superseded/);

    // Input still reaches the surface the client actually attached.
    session.handle({
      requestId: 'write-1',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-fast', bytes: toBase64Url(utf8Encode('ls')) },
    });
    expect(provider.writes).toEqual([['pty-fast', 'ls']]);
  });

  it('releases a handle that resolves after dispose, and answers nothing', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const slow = gate();
    provider.resolveGate = slow.promise;
    const { session, sent } = makeSession(provider);

    session.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-1', cols: 80, rows: 24 },
    });
    session.dispose();
    slow.release();
    await settle();

    expect(provider.released).toEqual(['pty-1']);
    expect(provider.streamed).toEqual([]);
    // A disposed session has no transport left to answer on.
    expect(sent).toEqual([]);
  });
});

describe('RemoteApiSession terminal input', () => {
  it('rejects write and resize unless the surface is the current attachment', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const background = provider.addSurface('surface-2', 'pty-2', 100, 30);
    const { session, sent } = makeSession(provider);

    await attach(session, 80, 24, 'surface-1');
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

    expect(provider.writes).toEqual([]);
    expect(background).toEqual({ ptyId: 'pty-2', cols: 100, rows: 30 });
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

    expect(provider.writes).toEqual([]);
    expect(sent).toEqual([
      {
        requestId: 'write-detached',
        ok: false,
        error: 'surface is not attached: surface-1',
      },
    ]);
  });

  it('rejects a write with no surfaceId at all', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    await attach(session, 100, 30);
    sent.length = 0;

    session.handle({
      requestId: 'write-1',
      method: REMOTE_METHODS.terminalWrite,
      params: { bytes: toBase64Url(utf8Encode('x')) },
    });

    expect(provider.writes).toEqual([]);
    expect(sent).toEqual([
      { requestId: 'write-1', ok: false, error: 'no such surface: (none)' },
    ]);
  });

  it('keeps write and resize pinned to the surface resolved at attach', async () => {
    const provider = new FakeProvider();
    const attached = provider.addSurface('surface-1', 'pty-1', 80, 24);
    const swappedIn = provider.addSurface('surface-2', 'pty-2', 100, 30);
    const { session, sent } = makeSession(provider);

    await attach(session, 90, 25, 'surface-1');
    // A Host-side pane swap moves a different terminal behind `surface-1`.
    provider.surfaces.set('surface-1', swappedIn);
    provider.surfaces.set('surface-2', attached);
    sent.length = 0;

    session.handle({
      requestId: 'write-after-swap',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode('still-attached\r')) },
    });

    expect(provider.writes).toEqual([['pty-1', 'still-attached\r']]);

    session.handle({
      requestId: 'resize-after-swap',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', cols: 120, rows: 40 },
    });

    // The owner's resize is synchronous; only the reply waits on the handle,
    // which for a pane elsewhere is a round trip.
    expect(attached).toEqual({ ptyId: 'pty-1', cols: 120, rows: 40 });
    expect(swappedIn).toEqual({ ptyId: 'pty-2', cols: 100, rows: 30 });

    await settle();
    expect(sent).toEqual([
      { requestId: 'write-after-swap', ok: true, result: {} },
      {
        subId: 'attach-1',
        event: REMOTE_EVENTS.terminalData,
        data: { bytes: toBase64Url(utf8Encode('terminal-resize:120x40')) },
      },
      { requestId: 'resize-after-swap', ok: true, result: { cols: 120, rows: 40 } },
    ]);
  });

  it('clamps a resize and keeps the current size for a dimension it cannot read', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    await attach(session, 90, 25);
    provider.handleResizes.length = 0;
    sent.length = 0;

    session.handle({
      requestId: 'resize-1',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', cols: 0, rows: 40.7 },
    });
    await settle();

    expect(provider.handleResizes).toEqual([['pty-1', 1, 40]]);
    expect(reply(sent, 'resize-1').result).toEqual({ cols: 1, rows: 40 });

    session.handle({
      requestId: 'resize-2',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', rows: Number.NaN },
    });
    await settle();

    // Neither dimension was usable, so the surface keeps the size it has.
    expect(provider.handleResizes.at(-1)).toEqual(['pty-1', 1, 40]);
    expect(reply(sent, 'resize-2').result).toEqual({ cols: 1, rows: 40 });
  });

  it('answers a rejected terminal resize instead of leaving it pending', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    await attach(session, 100, 30);
    provider.resizeError = new Error('owner unavailable');
    sent.length = 0;

    session.handle({
      requestId: 'resize-1',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-1', cols: 120, rows: 40 },
    });
    await settle();

    expect(reply(sent, 'resize-1')).toEqual({
      requestId: 'resize-1',
      ok: false,
      error: 'terminal resize failed: owner unavailable',
    });
  });

  it('discards a terminal report a mirror answered, and still answers ok', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    await attach(session, 100, 30);
    sent.length = 0;

    const reports = {
      da1: '\x1b[?1;2c',
      cpr: '\x1b[24;80R',
      kitty: '\x1b_Gi=1;OK\x1b\\',
      xtsmgraphics: '\x1b[?2;1;4096S',
      cellSize: '\x1b]1337;ReportCellSize=14.0;7.0;1.0\x07',
    };
    for (const [name, bytes] of Object.entries(reports)) {
      session.handle({
        requestId: `write-${name}`,
        method: REMOTE_METHODS.terminalWrite,
        params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode(bytes)) },
      });
    }

    expect(provider.writes).toEqual([]);
    expect(sent).toEqual(
      Object.keys(reports).map((name) => ({ requestId: `write-${name}`, ok: true, result: {} })),
    );

    // Real input is untouched, bracketed paste and a report glued to keystrokes
    // included — the classifier requires every token of the chunk to be a report.
    const inputs = ['ls\r', '\x1b[200~pasted\x1b[201~', '\x1b[A', '\x1b[13;5u', '\x1b[?1;2cls'];
    for (const [index, bytes] of inputs.entries()) {
      session.handle({
        requestId: `input-${index}`,
        method: REMOTE_METHODS.terminalWrite,
        params: { surfaceId: 'surface-1', bytes: toBase64Url(utf8Encode(bytes)) },
      });
    }

    expect(provider.writes).toEqual(inputs.map((bytes) => ['pty-1', bytes]));
  });
});

describe('RemoteApiSession surface.detach', () => {
  it('is idempotent, and a stale detach leaves a newer attachment alone', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    provider.addSurface('surface-2', 'pty-2', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30, 'surface-1');
    session.handle({
      requestId: 'detach-1',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });
    // Detaching again names a surface that is no longer attached: a no-op, not
    // an error.
    session.handle({
      requestId: 'detach-1-again',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });
    await attach(session, 100, 30, 'surface-2', 'attach-2');
    sent.length = 0;

    // A detach the client sent before it switched panes must not kill the
    // attachment it switched to.
    session.handle({
      requestId: 'detach-stale',
      method: REMOTE_METHODS.surfaceDetach,
      params: { surfaceId: 'surface-1' },
    });

    expect(sent).toEqual([{ requestId: 'detach-stale', ok: true, result: {} }]);
    expect(provider.unstreamed).toEqual(['pty-1']);
    session.handle({
      requestId: 'write-1',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-2', bytes: toBase64Url(utf8Encode('ok')) },
    });
    expect(provider.writes).toEqual([['pty-2', 'ok']]);
  });
});

describe('RemoteApiSession teardown', () => {
  it('waits for stream readiness and rejects an exit ordered before it', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    const ready = gate();
    provider.streamReadyGate = ready.promise;

    session.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-1', cols: 80, rows: 24 },
    });
    await settle();

    // A peer subscription is installed in another process. Until its ack
    // crosses back, even a same-size attach must not bounce or acknowledge.
    expect(sent).toEqual([]);
    expect(provider.ptyResizes).toEqual([]);

    provider.emitExit('pty-1', 23);
    ready.release();
    await settle();

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'surface closed while attaching: surface-1',
    });
    expect(sent.some((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalClosed)).toBe(
      false,
    );
    expect(provider.ptyResizes).toEqual([]);
  });

  it('fails the attach when the PTY exits while surface resolution is in flight', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    const held = gate();
    provider.resolveGate = held.promise;

    session.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-1', cols: 80, rows: 24 },
    });
    await settle();

    // There is no sink until resolution finishes. The provider records this
    // exit and replays it synchronously when the session tries to subscribe.
    provider.emitExit('pty-1', 23);
    held.release();
    await settle();

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'surface closed while attaching: surface-1',
    });
    expect(sent.some((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalClosed)).toBe(
      false,
    );
    expect(provider.streamed).toEqual(['pty-1']);
    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
    // A dead PTY is never bounced or otherwise resized after the replay.
    expect(provider.ptyResizes).toEqual([]);
    expect(provider.handleResizes).toEqual([]);
  });

  it('tears down the attachment when the attached PTY exits', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30, 'surface-1');
    sent.length = 0;

    // The attached PTY exits (process death, or the pane disposed on the Host).
    provider.emitExit('pty-1', 0);

    // The client is told the terminal closed...
    expect(sent).toEqual([
      {
        subId: 'attach-1',
        event: REMOTE_EVENTS.terminalClosed,
        data: { exitCode: 0 },
      },
    ]);
    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
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

    expect(provider.writes).toEqual([]);
    expect(provider.handleResizes).toEqual([['pty-1', 100, 30]]);
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

  it('fails the attach when the PTY exits while its resize is still in flight', async () => {
    // The stream is subscribed before the size settles, so an exit can land in
    // the middle of an attach that asked for a different size. The attachment is
    // already gone by the time the resize answers, so the attach is failed
    // rather than acknowledged — the buffered `terminal.closed` would otherwise
    // be flushed for a subscription the client is never given.
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);
    const held = gate();
    provider.resizeGate = held.promise;

    session.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-1', cols: 100, rows: 30 },
    });
    await settle();
    expect(provider.handleResizes).toEqual([['pty-1', 100, 30]]);

    provider.emitExit('pty-1', 0);
    held.release();
    await settle();

    expect(reply(sent, 'attach-1')).toEqual({
      requestId: 'attach-1',
      ok: false,
      error: 'surface closed while attaching: surface-1',
    });
    expect(sent.some((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalClosed)).toBe(
      false,
    );
    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
  });

  it('cancels a pending bounce when the attached PTY exits inside the window', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session } = makeSession(provider);

    await attach(session, 80, 24);
    provider.emitExit('pty-1', 1);
    vi.advanceTimersByTime(60);

    // Restoring the rows of a PTY that is gone is at best pointless.
    expect(provider.ptyResizes).toEqual([['pty-1', 80, 23]]);
  });

  it('dispose stops the stream, releases the handle, and ignores later requests', async () => {
    const provider = new FakeProvider();
    provider.addSurface('surface-1', 'pty-1', 80, 24);
    const { session, sent } = makeSession(provider);

    await attach(session, 100, 30);
    await watchDirectory(session);
    sent.length = 0;

    session.dispose();
    session.dispose(); // idempotent

    expect(provider.unstreamed).toEqual(['pty-1']);
    expect(provider.released).toEqual(['pty-1']);
    expect(provider.watchers).toBe(0);

    provider.emitData('pty-1', 'after dispose');
    session.handle({ requestId: 'hello-1', method: REMOTE_METHODS.hello, params: {} });
    expect(sent).toEqual([]);
  });
});
