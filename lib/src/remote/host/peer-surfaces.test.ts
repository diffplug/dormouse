/**
 * Attaching to a terminal owned by a *sibling* webview. Only one webview in a
 * VS Code window is the remote Host, but the window's terminals are spread
 * across all of them, so the Host has to reach the others through the peer
 * bridge (docs/specs/vscode.md → "Peer surfaces").
 *
 * This is the webview-backed {@link createWebviewSurfaceProvider} under test as
 * much as the session: the session itself knows nothing about registries or
 * peers (`host-surface-provider.ts`), so the local-vs-sibling distinction only
 * exists here.
 */

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
import { createWebviewSurfaceProvider } from './activation';
import { RemoteApiSession } from './remote-api';

type SentPayload = RemoteResponse | RemoteEventMsg;
type DataHandler = (detail: { id: string; data: string }) => void;
type ExitHandler = (detail: { id: string; exitCode: number }) => void;

/** A platform whose peer bridge stands in for the other webviews. */
class PeerPlatform {
  readonly dataHandlers = new Set<DataHandler>();
  readonly exitHandlers = new Set<ExitHandler>();
  readonly resizePty = vi.fn();
  readonly writePty = vi.fn();
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly ops: Array<{ surfaceId: string; op: string; cols?: number; rows?: number }> = [];
  readonly peerChangeHandlers = new Map<string, Set<() => void>>();

  /** Surfaces the imaginary sibling webview owns. */
  peerSurfaces = new Map<string, { ptyId: string; cols: number; rows: number }>();
  peerEntries: unknown[] = [];
  surfaceRequestGate: Promise<void> | null = null;

  /**
   * One generic seam: `op` is opaque to the adapter, and a peer answers with
   * zero or more results — none of them meaning nobody owns it.
   */
  readonly peers = {
    claimSingleton: () => {},
    request: async (op: string, params: unknown) => {
      if (op === 'directory') return this.peerEntries;
      await this.surfaceRequestGate;
      const { surfaceId, op: surfaceOp, cols, rows } =
        params as { surfaceId: string; op: string; cols?: number; rows?: number };
      this.ops.push({ surfaceId, op: surfaceOp, cols, rows });
      const surface = this.peerSurfaces.get(surfaceId);
      if (!surface) return [];
      if (surfaceOp !== 'detach' && cols && rows) {
        surface.cols = cols;
        surface.rows = rows;
      }
      return [{ ptyId: surface.ptyId, cols: surface.cols, rows: surface.rows }];
    },
    respond: () => {},
    notify: () => {},
    subscribe: (topic: string, listener: () => void) => {
      let handlers = this.peerChangeHandlers.get(topic);
      if (!handlers) {
        handlers = new Set();
        this.peerChangeHandlers.set(topic, handlers);
      }
      handlers.add(listener);
      return () => void handlers!.delete(listener);
    },
    streamPty: (id: string) => {
      this.subscribed.push(id);
      return () => void this.unsubscribed.push(id);
    },
  };

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
    for (const handler of this.dataHandlers) handler({ id, data });
  }
  emitPeerChange(topic: string): void {
    for (const handler of this.peerChangeHandlers.get(topic) ?? []) handler();
  }
  asAdapter(): PlatformAdapter {
    return this as unknown as PlatformAdapter;
  }
}

function decodeTerminalData(payload: SentPayload): string {
  const event = payload as RemoteEventMsg;
  return utf8Decode(fromBase64Url((event.data as { bytes: string }).bytes));
}

/** Let the peer round trips (they are promises) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A pane in *this* webview's registry, which resolves without asking anyone. */
function registerLocalSurface(surfaceId: string, ptyId: string) {
  const terminal = { cols: 80, rows: 24, resize: vi.fn() };
  registry.set(surfaceId, { ptyId, terminal } as unknown as TerminalEntry);
  return terminal;
}

/** Hold every peer surface round trip open until the returned function is called. */
function gatePeers(platform: PeerPlatform): () => void {
  let release!: () => void;
  platform.surfaceRequestGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

describe('remote-api peer surfaces', () => {
  afterEach(() => {
    registry.clear();
    setPlatform(new FakePtyAdapter());
  });

  function session(platform: PeerPlatform) {
    const sent: SentPayload[] = [];
    // The provider reads `getPlatform()` lazily, so it has to be built after
    // this platform is installed for its peer bridge to be the one under test.
    setPlatform(platform.asAdapter());
    return {
      sent,
      api: new RemoteApiSession({
        hostId: 'host-1',
        send: (payload) => sent.push(payload),
        provider: createWebviewSurfaceProvider(),
      }),
    };
  }

  it('attaches to a surface owned by another webview', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 100, rows: 30 },
    });
    await settle();

    // The owner did the resize — attach-is-the-resize has to go through the
    // live xterm, which this webview cannot touch.
    expect(platform.ops).toEqual([{ surfaceId: 'surface-far', op: 'attach', cols: 100, rows: 30 }]);
    const ok = sent.find((p) => (p as RemoteResponse).requestId === 'attach-1') as RemoteResponse;
    expect(ok.result).toEqual({ cols: 100, rows: 30 });
  });

  it('subscribes to the foreign PTY and streams its bytes', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    await settle();

    // The host only forwards pty:data for PTYs a webview owns or subscribed to.
    expect(platform.subscribed).toEqual(['pty-far']);

    platform.emitData('pty-far', 'hello from the other webview');
    const data = sent.filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalData);
    expect(data.map(decodeTerminalData)).toContain('hello from the other webview');
  });

  it('ignores bytes from PTYs it is not attached to', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    await settle();
    platform.emitData('pty-other', 'not mine');

    const data = sent.filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.terminalData);
    expect(data.map(decodeTerminalData)).not.toContain('not mine');
  });

  it('routes a later resize back to the owning webview', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    await settle();
    api.handle({
      requestId: 'resize-1',
      method: REMOTE_METHODS.terminalResize,
      params: { surfaceId: 'surface-far', cols: 120, rows: 40 },
    });
    await settle();

    expect(platform.ops.at(-1)).toEqual({ surfaceId: 'surface-far', op: 'resize', cols: 120, rows: 40 });
    const ok = sent.find((p) => (p as RemoteResponse).requestId === 'resize-1') as RemoteResponse;
    expect(ok.result).toEqual({ cols: 120, rows: 40 });
  });

  it('stops the foreign stream when the attachment is replaced', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    platform.peerSurfaces.set('surface-far2', { ptyId: 'pty-far2', cols: 80, rows: 24 });
    const { api } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    await settle();
    api.handle({
      requestId: 'attach-2',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far2', cols: 80, rows: 24 },
    });
    await settle();

    // Otherwise the host keeps forwarding a PTY nobody is reading.
    expect(platform.unsubscribed).toEqual(['pty-far']);
  });

  it('releases a peer handle that resolves after session disposal', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    const finishResolve = gatePeers(platform);
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    api.dispose();
    finishResolve();
    await settle();

    expect(platform.subscribed).toEqual(['pty-far']);
    expect(platform.unsubscribed).toEqual(['pty-far']);
    expect(sent.some((p) => (p as RemoteResponse).requestId === 'attach-1')).toBe(false);
  });

  it('does not let a gated peer attach outrank the newer attach that replaced it', async () => {
    const platform = new PeerPlatform();
    platform.peerSurfaces.set('surface-far', { ptyId: 'pty-far', cols: 80, rows: 24 });
    registerLocalSurface('surface-near', 'pty-near');
    const finishResolve = gatePeers(platform);
    const { api, sent } = session(platform);

    // The client attaches a sibling's pane and switches to a local one before
    // the sibling answers, so the two resolves land out of order.
    api.handle({
      requestId: 'attach-far',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-far', cols: 80, rows: 24 },
    });
    api.handle({
      requestId: 'attach-near',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-near', cols: 100, rows: 30 },
    });
    await settle();
    finishResolve();
    await settle();

    // Last attach wins: the superseded one unwinds the stream it opened on the
    // way instead of tearing down the newer attachment.
    expect(platform.unsubscribed).toEqual(['pty-far']);
    const near = sent.find((p) => (p as RemoteResponse).requestId === 'attach-near') as RemoteResponse;
    expect(near.ok).toBe(true);
    const far = sent.find((p) => (p as RemoteResponse).requestId === 'attach-far') as RemoteResponse;
    expect(far.ok).toBe(false);
    expect(far.error).toMatch(/superseded/);

    // Input still reaches the surface the client actually attached.
    api.handle({
      requestId: 'write-1',
      method: REMOTE_METHODS.terminalWrite,
      params: { surfaceId: 'surface-near', bytes: toBase64Url(utf8Encode('ls')) },
    });
    expect(platform.writePty).toHaveBeenCalledWith('pty-near', 'ls');
  });

  it('fails cleanly when no webview owns the surface', async () => {
    const platform = new PeerPlatform();
    const { api, sent } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'nobody', cols: 80, rows: 24 },
    });
    await settle();

    const reply = sent.find((p) => (p as RemoteResponse).requestId === 'attach-1') as RemoteResponse;
    expect(reply.error).toMatch(/no such surface/);
  });

  it('prefers a local surface without asking any peer', async () => {
    const platform = new PeerPlatform();
    registerLocalSurface('surface-near', 'pty-near');
    const { api } = session(platform);

    api.handle({
      requestId: 'attach-1',
      method: REMOTE_METHODS.surfaceAttach,
      params: { surfaceId: 'surface-near', cols: 80, rows: 24 },
    });
    await settle();

    expect(platform.ops).toEqual([]);
    expect(platform.subscribed).toEqual([]);
  });

  it('emits one snapshot merging this webview with its peers', async () => {
    const platform = new PeerPlatform();
    platform.peerEntries = [{ surfaceId: 'surface-far', title: 'other webview' }];
    registerLocalSurface('surface-near', 'pty-near');
    const { api, sent } = session(platform);

    api.handle({ requestId: 'dir-1', method: REMOTE_METHODS.directoryWatch, params: {} });
    await settle();

    const snapshots = sent
      .filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.directorySnapshot)
      .map((p) => ((p as RemoteEventMsg).data as { entries: Array<{ surfaceId: string }> }).entries);
    // The peer round trip is the provider's business now, so the phone gets one
    // snapshot per collect instead of local-then-merged (`remote-api.ts`).
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.map((e) => e.surfaceId)).toEqual(['surface-near', 'surface-far']);
  });

  it('resnapshots when a peer directory changes', async () => {
    const platform = new PeerPlatform();
    platform.peerEntries = [{ surfaceId: 'surface-far', title: 'before' }];
    const { api, sent } = session(platform);
    api.handle({ requestId: 'dir-1', method: REMOTE_METHODS.directoryWatch, params: {} });
    await settle();

    platform.peerEntries = [{ surfaceId: 'surface-far', title: 'after' }];
    platform.emitPeerChange('directory');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const snapshots = sent
      .filter((p) => (p as RemoteEventMsg).event === REMOTE_EVENTS.directorySnapshot)
      .map((p) => ((p as RemoteEventMsg).data as { entries: unknown[] }).entries);
    expect(snapshots.at(-1)).toEqual([{ surfaceId: 'surface-far', title: 'after' }]);
  });
});
