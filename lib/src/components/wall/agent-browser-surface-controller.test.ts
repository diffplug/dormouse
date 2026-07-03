/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import {
  HIDDEN_PARK_DELAY_MS,
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
  static OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  sent: string[] = [];

  constructor(public url: string) {
    WebSocketMock.instances.push(this);
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
});

describe('stale-port recovery gating', () => {
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
