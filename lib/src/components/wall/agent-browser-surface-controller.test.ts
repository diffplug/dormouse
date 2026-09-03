/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import {
  HIDDEN_PARK_DELAY_MS,
  PROVISIONAL_INPUT_WINDOW_MS,
  acquireAgentBrowserSurfaceController,
  disposeAgentBrowserSurfaceController,
  disposeAllAgentBrowserSurfaceControllers,
  getAgentBrowserSurfaceController,
  type AgentBrowserViewSink,
} from './agent-browser-surface-controller';

// These tests drive the controller directly, with NO React — it owns the whole
// non-React lifecycle, so it can be exercised in isolation.

class WebSocketMock {
  static instances: WebSocketMock[] = [];
  static failPorts = new Set<number>();
  static OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  sent: string[] = [];

  constructor(public url: string) {
    WebSocketMock.instances.push(this);
    const port = Number(new URL(url).port);
    if (WebSocketMock.failPorts.has(port)) {
      queueMicrotask(() => this.close());
      return;
    }
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string) { this.sent.push(data); }

  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeSink(): AgentBrowserViewSink & {
  updateParameters: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  requestIframeSwap: ReturnType<typeof vi.fn>;
} {
  return {
    canvas: document.createElement('canvas'),
    viewport: document.createElement('div'),
    updateParameters: vi.fn(),
    setTitle: vi.fn(),
    requestIframeSwap: vi.fn(),
  };
}

const streamSockets = (port: number) =>
  WebSocketMock.instances.filter((ws) => ws.url === `ws://127.0.0.1:${port}`);
const streamSocket = (port: number) => streamSockets(port).at(-1);

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketMock);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  WebSocketMock.instances = [];
  WebSocketMock.failPorts = new Set<number>();
  setPlatform(new FakePtyAdapter());
});

afterEach(() => {
  disposeAllAgentBrowserSurfaceControllers();
  vi.restoreAllMocks();
  setPlatform(new FakePtyAdapter());
});

describe('registry idempotency', () => {
  it('acquire is get-or-create; dispose is idempotent and clears the registry', () => {
    const a = acquireAgentBrowserSurfaceController('id', { session: 'sess' });
    const b = acquireAgentBrowserSurfaceController('id', { session: 'sess' });
    expect(b).toBe(a);
    expect(getAgentBrowserSurfaceController('id')).toBe(a);

    disposeAgentBrowserSurfaceController('id');
    expect(getAgentBrowserSurfaceController('id')).toBeNull();
    // Dispose-by-id on an absent controller (iframe/terminal surface) is a no-op.
    expect(() => disposeAgentBrowserSurfaceController('id')).not.toThrow();
    expect(() => disposeAgentBrowserSurfaceController('never-existed')).not.toThrow();

    const c = acquireAgentBrowserSurfaceController('id', { session: 'sess' });
    expect(c).not.toBe(a);
  });
});

describe('view attachment', () => {
  it('attach → detach → attach keeps a single connection (StrictMode-safe)', async () => {
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
    const first = makeSink();
    const h1 = controller.attachView(first);
    await flushMicrotasks();
    expect(streamSockets(4321).length).toBe(1);

    h1.detach();
    const second = makeSink();
    controller.attachView(second);
    await flushMicrotasks();

    // The connection lives on the controller and survives the detach/attach; no
    // second socket is opened.
    expect(streamSockets(4321).length).toBe(1);
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it("a stale handle's detach is a no-op once a newer view has attached", async () => {
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
    const first = makeSink();
    const h1 = controller.attachView(first);
    await flushMicrotasks();
    const second = makeSink();
    controller.attachView(second);
    // The interleaved-order case: the stale handle detaches AFTER the newer view
    // attached — it must not unbind the live sink.
    h1.detach();

    // The still-bound (second) sink receives buffered writes; prove it is live by
    // observing a URL mirror land on it.
    const socket = streamSocket(4321);
    socket?.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'X', url: 'https://example.com/', active: true }],
    }));
    expect(second.updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });
    expect(first.updateParameters).not.toHaveBeenCalled();
  });
});

describe('provisional stream paint', () => {
  it('draws the native stream frame before the crisp screenshot resolves', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const screenshot = vi.fn(() => new Promise<never>(() => {}));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
    platform.agentBrowserScreenshot = screenshot;
    setPlatform(platform);

    const bitmap = { width: 40, height: 30, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const sink = makeSink();
    const drawImage = vi.fn();
    sink.canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof sink.canvas.getContext;

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
    controller.attachView(sink);
    await flushMicrotasks();

    controller.send({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    streamSocket(4321)?.emitMessage(JSON.stringify({
      type: 'frame',
      data: btoa('low-latency-frame'),
      metadata: { deviceWidth: 40, deviceHeight: 30 },
    }));
    await flushMicrotasks();

    expect(screenshot).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(sink.canvas.width).toBe(40);
    expect(sink.canvas.height).toBe(30);
    expect(controller.snapshot().hasFrame).toBe(true);

    // Once pointer activity is old, an animated page must not keep decoding its
    // CSS-resolution stream at frame rate; the throttled crisp path remains.
    now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    streamSocket(4321)?.emitMessage(JSON.stringify({
      type: 'frame',
      data: btoa('idle-animation-frame'),
      metadata: { deviceWidth: 40, deviceHeight: 30 },
    }));
    await flushMicrotasks();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it('repaints a byte-identical crisp capture over a provisional paint', async () => {
    // A provisional paint puts blurry pixels on the canvas without going through
    // the screenshot loop, so the loop's byte-dedup no longer describes what is on
    // screen. On a resting page the next crisp capture is byte-identical to the
    // last crisp draw — it must still repaint, or the pane stays blurry until the
    // page happens to change.
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // A static page: every capture returns the same pixels.
    const screenshot = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([9, 9, 9]), mime: 'image/jpeg' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
    platform.agentBrowserScreenshot = screenshot;
    setPlatform(platform);

    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 40, height: 30, close: vi.fn() })));
    const sink = makeSink();
    const drawImage = vi.fn();
    sink.canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof sink.canvas.getContext;

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
    controller.attachView(sink);
    await flushMicrotasks();

    // The first stream frame paints provisionally (nothing on the canvas yet), so
    // hasFrame flips and the provisional window can be closed from here on.
    streamSocket(4321)?.emitMessage(JSON.stringify({ type: 'frame', data: btoa('first') }));
    await flushMicrotasks();
    expect(controller.snapshot().hasFrame).toBe(true);

    // Past the input window a frame is a bare pulse — no provisional paint — so
    // this capture lands as the crisp resting frame the loop records.
    now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    streamSocket(4321)?.emitMessage(JSON.stringify({ type: 'frame', data: btoa('rest') }));
    await flushMicrotasks();
    const afterCrisp = drawImage.mock.calls.length;
    expect(screenshot).toHaveBeenCalled();

    // Pointer input reopens the window; this frame paints blurry over the crisp one.
    controller.send({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    streamSocket(4321)?.emitMessage(JSON.stringify({ type: 'frame', data: btoa('hover') }));
    await flushMicrotasks();
    const afterProvisional = drawImage.mock.calls.length;
    expect(afterProvisional).toBeGreaterThan(afterCrisp);

    // Back at rest: the capture's bytes match the earlier crisp draw exactly, and
    // it must still repaint over the blur.
    now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    streamSocket(4321)?.emitMessage(JSON.stringify({ type: 'frame', data: btoa('settled') }));
    await flushMicrotasks();
    expect(drawImage.mock.calls.length).toBeGreaterThan(afterProvisional);
  });
});

describe('parking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detach parks after the debounce and resets hasFrame', async () => {
    const screenshot = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
    platform.agentBrowserScreenshot = screenshot;
    setPlatform(platform);
    // Give the draw path a bitmap so hasFrame can flip true without a real canvas.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
    const sink = makeSink();
    const handle = controller.attachView(sink);
    await vi.advanceTimersByTimeAsync(0);
    const socket = streamSocket(4321);
    expect(socket?.readyState).toBe(1);

    // Drive one frame → screenshot → draw → hasFrame true.
    socket?.emitMessage(JSON.stringify({ type: 'frame', data: 'x'.repeat(32) }));
    await vi.advanceTimersByTimeAsync(300);
    expect(screenshot).toHaveBeenCalled();
    expect(controller.snapshot().hasFrame).toBe(true);

    // Detach immediately drops hasFrame (the canvas DOM died with the unmount).
    handle.detach();
    expect(controller.snapshot().hasFrame).toBe(false);

    // After the debounce the connection is torn down (parked), and nothing
    // reconnects while detached.
    await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
    expect(socket?.readyState).toBe(3);
    expect(streamSockets(4321).length).toBe(1);
    expect(controller.isParked()).toBe(true);
  });
});

describe('re-attach repaint', () => {
  it('schedules a repaint capture when re-attaching to a live connection', async () => {
    vi.useFakeTimers();
    try {
      const screenshot = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }));
      const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
      platform.agentBrowserScreenshot = screenshot;
      setPlatform(platform);
      vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));

      const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 4321 });
      const first = makeSink();
      const h1 = controller.attachView(first);
      await vi.advanceTimersByTimeAsync(0);
      expect(streamSocket(4321)?.readyState).toBe(1);

      // Detach but stay within the park debounce, so the connection (and its
      // screenshot loop) survive.
      h1.detach();
      screenshot.mockClear();

      // Re-attach to that live, unparked connection → one repaint capture, so a
      // view remounted within the debounce doesn't sit blank.
      controller.attachView(makeSink());
      await vi.advanceTimersByTimeAsync(300);
      expect(screenshot).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('param-write buffering', () => {
  it('buffers writes while detached and flushes them on the next attach', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    // Returning no cdp-url keeps the popped-out CDP observer from opening a
    // second socket, so only the stream socket exists.
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setPlatform(platform);

    // Popped out ⇒ exempt from parking, so a detached (minimized) pane keeps its
    // stream observer and can still record a URL change.
    const controller = acquireAgentBrowserSurfaceController('id', {
      session: 'sess', wsPort: 1111, renderMode: 'ab-popout', url: 'https://google.com/',
    });
    const first = makeSink();
    const handle = controller.attachView(first);
    await flushMicrotasks();
    const socket = streamSocket(1111);

    handle.detach();
    // Observe a navigation while detached — the write must buffer, not drop.
    socket?.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Example', url: 'https://example.com/', active: true }],
    }));
    expect(first.updateParameters).not.toHaveBeenCalled();

    const second = makeSink();
    controller.attachView(second);
    expect(second.updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });
  });
});

describe('updateParams', () => {
  it('does not loop when the view echoes a param the controller just wrote', async () => {
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    const socket = streamSocket(1111);

    socket?.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Example', url: 'https://example.com/', active: true }],
    }));
    expect(sink.updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });
    const writesBefore = sink.updateParameters.mock.calls.length;

    // The view feeds the echoed url back; the controller already has it, so no
    // re-write and no reconnect.
    controller.updateParams({ session: 'sess', wsPort: 1111, url: 'https://example.com/' });
    expect(sink.updateParameters.mock.calls.length).toBe(writesBefore);
    expect(streamSockets(1111).length).toBe(1);
  });

  it('reconciles a changed session when its params port already matches the live port', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopOut'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserPopOut = vi.fn(async () => ({ ok: true, wsPort: 2222 }));
    setPlatform(platform);

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'old-session', wsPort: 1111 });
    controller.attachView(makeSink());
    await flushMicrotasks();

    // The relaunch adopts 2222 immediately, but params.wsPort remains 1111
    // until the view's buffered write echoes back through updateParams.
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    await flushMicrotasks();
    const oldSessionSocket = streamSocket(2222);
    expect(oldSessionSocket?.readyState).toBe(1);
    expect(streamSockets(2222)).toHaveLength(1);

    // The echo also hands over a new session. Since 2222 is already the live
    // port, setStreamPort no-ops; session reconciliation must still replace the
    // old-session connection with one keyed to new-session.
    controller.updateParams({ session: 'new-session', wsPort: 2222 });
    await flushMicrotasks();

    expect(oldSessionSocket?.readyState).toBe(3);
    expect(streamSockets(2222)).toHaveLength(2);
  });
});

describe('stale-port recovery gating', () => {
  it('stays fully inert for a session-less pane until params deliver the session', async () => {
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: true, wsPort: 2222 }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
    platform.agentBrowserStreamStatus = streamStatus;
    setPlatform(platform);

    // The pane context menu's instant connect mounts its surface WITHOUT a
    // session precisely so nothing here can race the daemon boot — no recovery
    // query, no socket (docs/specs/dor-browser.md → Pane Context Menu Connect).
    // Deriving the session from `key` would silently reintroduce the race.
    const controller = acquireAgentBrowserSurfaceController('id', { key: 'default', url: 'http://localhost:5173/' });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    expect(streamStatus).not.toHaveBeenCalled();
    expect(WebSocketMock.instances).toHaveLength(0);

    // The background boot hands over {session, wsPort} in one params write,
    // which is what brings the stream up.
    controller.updateParams({ key: 'default', url: 'http://localhost:5173/', session: 'sess', wsPort: 1111 });
    await flushMicrotasks();
    expect(streamSocket(1111)?.readyState).toBe(1);
  });

  it('never queries stream status while parked', async () => {
    vi.useFakeTimers();
    try {
      const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: false }));
      const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
      platform.agentBrowserStreamStatus = streamStatus;
      setPlatform(platform);

      // No wsPort ⇒ the recovery path is what would query the daemon.
      const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess' });
      const sink = makeSink();
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      streamStatus.mockClear();

      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);
      expect(streamStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recover a stale port through stream status after that port opened live', async () => {
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: true, wsPort: 2222 }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
    platform.agentBrowserStreamStatus = streamStatus;
    setPlatform(platform);

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    streamStatus.mockClear();

    // The live port dropping is a stream failure, not a stale persisted port.
    streamSocket(1111)?.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    await flushMicrotasks();
    expect(streamStatus).not.toHaveBeenCalled();
  });

  it('clears live-port memory while parked so unpark can recover a changed stream port', async () => {
    vi.useFakeTimers();
    try {
      const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: true, wsPort: 2222 }));
      const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
      platform.agentBrowserStreamStatus = streamStatus;
      setPlatform(platform);

      const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
      const sink = makeSink();
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      expect(streamSocket(1111)?.readyState).toBe(1);
      streamStatus.mockClear();

      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);

      WebSocketMock.failPorts.add(1111);
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(0);

      expect(streamStatus).toHaveBeenCalledWith('sess', undefined);
      expect(sink.updateParameters).toHaveBeenCalledWith({ wsPort: 2222 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not query the daemon while a relaunch is in flight', async () => {
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: true, wsPort: 9999 }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus' | 'agentBrowserCommand' | 'agentBrowserPopOut'>;
    platform.agentBrowserStreamStatus = streamStatus;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    // A pop-out whose promise never settles pins `relaunching` true.
    platform.agentBrowserPopOut = vi.fn(() => new Promise(() => {}));
    setPlatform(platform);

    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    streamStatus.mockClear();

    // A stream drop mid-relaunch must not spawn a competing daemon via recovery.
    streamSocket(1111)?.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    await flushMicrotasks();
    expect(streamStatus).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('tears down the socket, timers, and screen registration', async () => {
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    const socket = streamSocket(1111);
    expect(socket?.readyState).toBe(1);
    expect(getAgentBrowserScreenController('id')).not.toBeNull();

    disposeAgentBrowserSurfaceController('id');

    expect(socket?.readyState).toBe(3);
    expect(getAgentBrowserScreenController('id')).toBeNull();
    expect(getAgentBrowserSurfaceController('id')).toBeNull();
  });
});

describe('relaunch (pop-out / pop-in)', () => {
  type RelaunchPlatform = FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopOut' | 'agentBrowserPopIn' | 'agentBrowserStreamStatus'>;
  function relaunchPlatform(): RelaunchPlatform & { resolvePopOut: (res: { ok: boolean; wsPort?: number }) => void } {
    const platform = new FakePtyAdapter() as RelaunchPlatform;
    let resolvePopOut!: (res: { ok: boolean; wsPort?: number }) => void;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 9999 }));
    platform.agentBrowserPopOut = vi.fn(() => new Promise<{ ok: boolean; wsPort?: number }>((r) => { resolvePopOut = r; }));
    platform.agentBrowserPopIn = vi.fn(async () => ({ ok: true, wsPort: 5555 }));
    setPlatform(platform);
    return Object.assign(platform, { resolvePopOut: (res: { ok: boolean; wsPort?: number }) => resolvePopOut(res) });
  }

  it('drops the stream up front and connects to the host\'s port only once the relaunch ends', async () => {
    const platform = relaunchPlatform();
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    const old = streamSocket(1111);
    expect(old?.readyState).toBe(1);

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    await flushMicrotasks();
    // The host is about to close this browser and kill its daemon: the old
    // socket is released now rather than left to fail into "ended"/recovery.
    expect(old?.readyState).toBe(3);
    expect(controller.snapshot().relaunching).toBe(true);
    expect(controller.snapshot().poppedOut).toBe(true);
    // No daemon command while the relaunch is in flight: not even the popped-out
    // CDP observer's `get cdp-url`.
    expect(platform.agentBrowserCommand).not.toHaveBeenCalledWith('sess', ['get', 'cdp-url'], undefined);

    platform.resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(controller.snapshot().relaunching).toBe(false);
    expect(streamSockets(3456).length).toBe(1);
    expect(streamSockets(1111).length).toBe(1);
    expect(platform.agentBrowserCommand).toHaveBeenCalledWith('sess', ['get', 'cdp-url'], undefined);
    expect(platform.agentBrowserStreamStatus).not.toHaveBeenCalled();
  });

  it('ignores a second pop-out or pop-in while one is in flight', async () => {
    const platform = relaunchPlatform();
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111 });
    controller.attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    controller.popIn();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    await flushMicrotasks();

    expect(platform.agentBrowserPopOut).toHaveBeenCalledTimes(1);
    expect(platform.agentBrowserPopIn).not.toHaveBeenCalled();
    expect(controller.snapshot().poppedOut).toBe(true);

    platform.resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    controller.popIn();
    expect(platform.agentBrowserPopIn).toHaveBeenCalledTimes(1);
  });

  it('pop-in on a session-less popped-out pane is a no-op', async () => {
    const platform = relaunchPlatform();
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-popout' });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    controller.popIn();
    expect(platform.agentBrowserPopIn).not.toHaveBeenCalled();
    expect(controller.snapshot().poppedOut).toBe(true);
    expect(sink.updateParameters).not.toHaveBeenCalledWith({ renderMode: 'ab-screencast' });
  });

  it('a relaunch carries the URL the stream committed, not the one the last tabs snapshot reported', async () => {
    const platform = relaunchPlatform();
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', wsPort: 1111, url: 'https://before.example/' });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    const socket = streamSocket(1111);
    socket?.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Before', url: 'https://before.example/', active: true }],
    }));
    // A navigation commits to a page that is still loading: `tabs` will not
    // refresh until the load completes.
    socket?.emitMessage(JSON.stringify({ type: 'url', url: 'https://slow.example/' }));
    expect(getAgentBrowserScreenController('id')?.chrome().url).toBe('https://slow.example/');
    expect(getAgentBrowserScreenController('id')?.chrome().title).toBeNull();
    expect(sink.updateParameters).toHaveBeenCalledWith({ url: 'https://slow.example/' });

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: 'https://slow.example/' }), undefined);
  });

  it('clears a stale title when navigation commits at the same URL', async () => {
    const controller = acquireAgentBrowserSurfaceController('id', {
      session: 'sess', wsPort: 1111, url: 'https://same.example/',
    });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    const socket = streamSocket(1111);
    socket?.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Before reload', url: 'https://same.example/', active: true }],
    }));
    expect(getAgentBrowserScreenController('id')?.chrome().title).toBe('Before reload');

    socket?.emitMessage(JSON.stringify({ type: 'url', url: 'https://same.example/' }));

    expect(getAgentBrowserScreenController('id')?.chrome()).toMatchObject({
      url: 'https://same.example/',
      title: null,
    });
    expect(sink.setTitle).toHaveBeenLastCalledWith('same.example');
    const titleWrites = sink.setTitle.mock.calls.length;

    socket?.emitMessage(JSON.stringify({ type: 'url', url: 'https://same.example/' }));
    expect(sink.setTitle).toHaveBeenCalledTimes(titleWrites);
  });

  it('a single {session, wsPort} handover connects once and asks the daemon nothing', async () => {
    const platform = relaunchPlatform();
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://x.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(WebSocketMock.instances.length).toBe(0);

    controller.updateParams({ session: 'sess', wsPort: 4321, url: 'https://x.example/' });
    await flushMicrotasks();
    expect(streamSockets(4321).length).toBe(1);
    expect(platform.agentBrowserStreamStatus).not.toHaveBeenCalled();
  });
});
