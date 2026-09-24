/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { VIEWER_TEXT_INPUT_MAX, encodeViewerFrame, type BrowserRequest, type BrowserResult } from '../../lib/platform/browser-automation';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { forgetLaunchBinaryPaths, launchBinaryPath, rememberLaunchBinaryPath } from './browser-automation';
import {
  HIDDEN_PARK_DELAY_MS,
  acquireAgentBrowserSurfaceController,
  closeBrowserSurface,
  disposeAgentBrowserSurfaceController,
  handOverBrowserStream,
  whenBrowserLaunched,
  type AgentBrowserSurfaceController,
  type AgentBrowserSurfaceParams,
  disposeAllAgentBrowserSurfaceControllers,
  getAgentBrowserSurfaceController,
  type AgentBrowserViewSink,
} from './agent-browser-surface-controller';
import { installBrowserHost, type BrowserAnswers } from './wall-test-utils';
import { createBrowserHost } from '../../host/browser-host';
import { fakeProvider } from '../../host/browser-host-test-utils';

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

  binaryType = 'blob';
  send(data: string) { this.sent.push(data); }

  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  emitMessage(data: string | ArrayBuffer) {
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
  requestRenderSwap: ReturnType<typeof vi.fn>;
  launchFailed: ReturnType<typeof vi.fn>;
} {
  return {
    canvas: document.createElement('canvas'),
    viewport: document.createElement('div'),
    updateParameters: vi.fn(),
    setTitle: vi.fn(),
    requestRenderSwap: vi.fn(),
    launchFailed: vi.fn(),
  };
}

/** A frame the host sends over a viewer socket. */
function emitFrame(socket: WebSocketMock | undefined, kind: 'provisional' | 'crisp' = 'provisional', n = 1, size?: { width: number; height: number }) {
  socket?.emitMessage(encodeViewerFrame({ kind, jpeg: new Uint8Array([0xff, 0xd8, n]), ...(size ? { size } : {}) }).buffer);
}

/** A controller whose first start streams from `port`, as `dor ab` hands
 *  one over. */
function withPort(id: string, params: AgentBrowserSurfaceParams, port: number): AgentBrowserSurfaceController {
  const controller = acquireAgentBrowserSurfaceController(id, params);
  controller.handOver(port);
  return controller;
}

/** The pages a controller navigated its live browser to, in order. */
const opens = (host: Pick<ReturnType<typeof installBrowserHost>, 'requests'>) =>
  host.requests('navigate').map((request) => request.url);

const streamSockets = (port: number) =>
  WebSocketMock.instances.filter((ws) => ws.url === `ws://127.0.0.1:${port}`);
const streamSocket = (port: number) => streamSockets(port).at(-1);

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** A browser that stays pending, until `resolve` answers it. */
function pending(): { promise: Promise<BrowserResult>; resolve: (result: BrowserResult) => void } {
  let resolve!: (result: BrowserResult) => void;
  const promise = new Promise<BrowserResult>((r) => { resolve = r; });
  return { promise, resolve };
}

/** An agent-browser request for session `sess`. */
const onSess = (op: Record<string, unknown>) => ({ provider: 'agent-browser', binding: { session: 'sess' }, ...op });

beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketMock);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  WebSocketMock.instances = [];
  WebSocketMock.failPorts = new Set<number>();
  // A host that grants every viewer socket, at the stream's number as its port.
  installBrowserHost();
});

afterEach(() => {
  disposeAllAgentBrowserSurfaceControllers();
  forgetLaunchBinaryPaths();
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
    const controller = withPort('id', { session: 'sess' }, 4321);
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
    const controller = withPort('id', { session: 'sess' }, 4321);
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

describe('painting', () => {
  /** An attached pane viewing `sess:4321`, its decodes answered by the test,
   *  in order, and its canvas recording what is drawn. */
  async function paintFixture(clipboardText?: string) {
    const host = installBrowserHost();
    const platform: PlatformAdapter = host.platform;
    if (clipboardText !== undefined) platform.readClipboardText = vi.fn(async () => clipboardText);
    const decodes: { bytes: number; resolve: (bitmap: ImageBitmap) => void }[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return new Promise<ImageBitmap>((resolve) => decodes.push({ bytes: bytes[2], resolve }));
    }));
    const sink = makeSink();
    const drawImage = vi.fn();
    sink.canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof sink.canvas.getContext;
    const controller = withPort('id', { session: 'sess' }, 4321);
    controller.attachView(sink);
    await flushMicrotasks();
    const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
    /** Decode the next waiting frame as a `width`×`height` image. */
    const decode = async (width: number, height: number) => {
      await vi.waitFor(() => expect(decodes.length).toBeGreaterThan(0));
      decodes.shift()!.resolve(bitmap(width, height));
      await flushMicrotasks();
    };
    return { host, sink, drawImage, controller, decodes, decode };
  }

  it('draws each frame over the whole canvas, sized by the crisp one so a provisional one reallocates nothing', async () => {
    const { sink, drawImage, controller, decode } = await paintFixture();
    const sizes: string[] = [];
    const record = () => sizes.push(`${sink.canvas.width}x${sink.canvas.height}`);

    emitFrame(streamSocket(4321), 'provisional', 1, { width: 40, height: 30 });
    await decode(40, 30);
    record();
    expect(controller.snapshot().hasFrame).toBe(true);
    // The device-resolution capture that replaces it sizes the canvas.
    emitFrame(streamSocket(4321), 'crisp', 2);
    await decode(80, 60);
    record();
    // Hover: the CSS-resolution stream paints into that same canvas, scaled.
    emitFrame(streamSocket(4321), 'provisional', 3);
    await decode(40, 30);
    record();
    emitFrame(streamSocket(4321), 'crisp', 4);
    await decode(80, 60);
    record();
    expect(sizes).toEqual(['40x30', '80x60', '80x60', '80x60']);
    expect(drawImage.mock.calls.map((call) => call.slice(1))).toEqual([[0, 0, 40, 30], [0, 0, 80, 60], [0, 0, 80, 60], [0, 0, 80, 60]]);
    // The frame's viewport size drives the screen indicator and sync.
    expect(controller.getDeviceSize()).toEqual({ width: 40, height: 30 });

    // A resized viewport's frame is another shape: the canvas follows it.
    emitFrame(streamSocket(4321), 'provisional', 5, { width: 50, height: 30 });
    await decode(50, 30);
    expect(`${sink.canvas.width}x${sink.canvas.height}`).toBe('50x30');
  });

  it('decodes the newest frame only: one at a time, a later arrival replacing the one waiting', async () => {
    const { drawImage, decodes, decode } = await paintFixture();
    for (let n = 1; n <= 4; n++) emitFrame(streamSocket(4321), 'provisional', n);
    await flushMicrotasks();
    expect(decodes.map((d) => d.bytes)).toEqual([1]);
    await decode(40, 30);
    // Frames 2 and 3 were replaced while 1 decoded; 4 paints next.
    expect(decodes.map((d) => d.bytes)).toEqual([4]);
    await decode(40, 30);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('sends input, pasted text and repaint requests over the viewer socket, and editing chords to the host', async () => {
    const { host, controller } = await paintFixture('pasted\r\ntext');
    const sent = () => streamSocket(4321)!.sent.map((raw) => JSON.parse(raw));
    controller.handleKeyDownLike({ key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(sent().at(-1)).toMatchObject({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', text: 'a' });
    // A paste goes as text, whichever provider: the host inserts it.
    controller.handleKeyDownLike({ key: 'v', code: 'KeyV', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    await flushMicrotasks();
    expect(sent().at(-1)).toEqual({ type: 'input_text', text: 'pasted\ntext' });
    controller.handleKeyDownLike({ key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    expect(host.requests('edit')).toEqual([onSess({ op: 'edit', edit: 'selectAll' })]);
    // A view remounted over the open socket asks the host for the last frame.
    controller.attachView(makeSink());
    expect(sent().at(-1)).toEqual({ type: 'repaint' });
  });
});

describe('sync-to-pane', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('issues one viewport once a pane resize settles, and re-syncs a display-scale change at once', async () => {
    const host = installBrowserHost();
    // The pane observer fires whenever the test resizes the pane.
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    // A display-scale change fires the `(resolution)` query armed for the old scale.
    const queries: Array<{ media: string; onChange?: () => void }> = [];
    vi.stubGlobal('matchMedia', (media: string) => {
      const query: { media: string; onChange?: () => void } = { media };
      queries.push(query);
      return {
        addEventListener: (_type: string, listener: () => void) => { query.onChange = listener; },
        removeEventListener: () => { query.onChange = undefined; },
      };
    });
    let dpr = 1;
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => dpr);
    const sink = makeSink();
    let size = { width: 800, height: 600 };
    sink.viewport.getBoundingClientRect = () => ({ ...size }) as DOMRect;
    const resizePane = (width: number, height: number) => {
      size = { width, height };
      observers.at(-1)?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
    };
    const viewports = () => host.requests('viewport').map(({ width, height, dpr }) => [width, height, dpr]);

    const controller = withPort('id', { session: 'sess' }, 4321);
    controller.attachView(sink);
    await flushMicrotasks();
    // Sync is engaged by default, so attaching sized the browser to the pane.
    expect(host.requests('viewport').at(-1)).toEqual(onSess({ op: 'viewport', width: 800, height: 600, dpr: 1 }));
    const issued = viewports().length;

    // A window drag resizes the pane every frame; one viewport lands after it settles.
    for (let w = 801; w <= 860; w++) {
      resizePane(w, 600);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(viewports()).toHaveLength(issued);
    await vi.advanceTimersByTimeAsync(200);
    expect(viewports().slice(issued)).toEqual([[860, 600, 1]]);

    dpr = 2;
    queries.at(-1)!.onChange!();
    expect(viewports().at(-1)).toEqual([860, 600, 2]);
    // Re-armed for the new scale.
    expect(queries.at(-1)!.media).toBe('(resolution: 2dppx)');
    expect(queries.at(-1)!.onChange).toBeDefined();
  });
});

describe('sync-to-pane while parked', () => {
  it('pushes a resize made behind a hidden pane once it is live again', async () => {
    vi.useFakeTimers();
    try {
      const host = installBrowserHost({ attach: async () => ({ ok: true, stream: 4321 }) });
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { observers.push(callback); }
        observe() {}
        disconnect() {}
      });
      const sink = makeSink();
      let size = { width: 800, height: 600 };
      sink.viewport.getBoundingClientRect = () => ({ ...size }) as DOMRect;
      const viewports = () => host.requests('viewport').map(({ width, height, dpr }) => [width, height, dpr]);

      const controller = withPort('id', { session: 'sess' }, 4321);
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);

      size = { width: 1000, height: 700 };
      observers.at(-1)?.([{ contentRect: { width: 1000, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
      await vi.advanceTimersByTimeAsync(250);
      expect(viewports().at(-1)).toEqual([800, 600, 1]);

      // Unparked at the same port: the size it missed still goes out.
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(viewports().at(-1)).toEqual([1000, 700, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('detach parks after the debounce and resets hasFrame', async () => {
    // Give the draw path a bitmap so hasFrame can flip true without a real canvas.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));

    const controller = withPort('id', { session: 'sess' }, 4321);
    const sink = makeSink();
    const handle = controller.attachView(sink);
    await vi.advanceTimersByTimeAsync(0);
    const socket = streamSocket(4321);
    expect(socket?.readyState).toBe(1);

    // One frame → draw → hasFrame true.
    emitFrame(socket, 'crisp');
    await vi.advanceTimersByTimeAsync(0);
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

describe('param-write buffering', () => {
  it('buffers writes while detached and flushes them on the next attach', async () => {
    // Answering no CDP endpoint keeps the popped-out CDP observer from opening
    // a second socket, so only the stream socket exists.
    installBrowserHost();

    // Popped out ⇒ exempt from parking, so a detached (minimized) pane keeps its
    // stream observer and can still record a URL change.
    const controller = withPort('id', {
      session: 'sess', renderMode: 'ab-popout', url: 'https://google.com/',
    }, 1111);
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
    const controller = withPort('id', { session: 'sess' }, 1111);
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
    controller.updateParams({ session: 'sess', url: 'https://example.com/' });
    expect(sink.updateParameters.mock.calls.length).toBe(writesBefore);
    expect(streamSockets(1111).length).toBe(1);
  });

  it('follows a headedness the host reports, for either provider', async () => {
    installBrowserHost();
    for (const [id, screencast, popout] of [['ab', 'ab-screencast', 'ab-popout'], ['pw', 'pw-screencast', 'pw-popout']] as const) {
      const controller = withPort(id, { renderMode: screencast, session: 'sess' }, 1111);
      controller.attachView(makeSink());
      await flushMicrotasks();
      // `surface.browser` records a native `open --headed` in params.
      controller.updateParams({ renderMode: popout, session: 'sess' });
      expect(controller.snapshot().poppedOut, id).toBe(true);
      expect(getAgentBrowserScreenController(id)!.snapshot().renderMode).toBe(popout);
    }
  });
});

describe('launch', () => {
  function launchHost(launch: NonNullable<BrowserAnswers['launch']>) {
    return installBrowserHost({ launch, attach: async () => ({ ok: true, stream: 9999 }) });
  }

  it('a session-less pane opens its page, binds the session the host answers with, and streams', async () => {
    const host = launchHost(async () => ({ ok: true, session: 'dormouse.1.gui-abc', stream: 4321, binaryPath: '/usr/bin/agent-browser' }));
    const launched = whenBrowserLaunched('id');
    // A restored pane whose launch never landed is the same pane.
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-screencast', url: 'https://page.example/', binaryPath: '/usr/bin/agent-browser',
    });
    const sink = makeSink();
    controller.attachView(sink);
    expect(controller.snapshot().phase).toBe('launching');
    await flushMicrotasks();

    expect(host.requests('launch')).toEqual([{
      provider: 'agent-browser', binding: { binaryPath: '/usr/bin/agent-browser' }, op: 'launch', url: 'https://page.example/', headed: false,
    }]);
    expect(sink.updateParameters).toHaveBeenCalledWith({ session: 'dormouse.1.gui-abc', binaryPath: '/usr/bin/agent-browser' });
    expect(streamSocket(4321)?.readyState).toBe(1);
    expect(host.requests('attach')).toEqual([]);
    expect(await launched).toBeNull();
    // Driven as the session it bound.
    getAgentBrowserScreenController('id')!.chromeActions.reload();
    expect(host.browser).toHaveBeenLastCalledWith({
      provider: 'agent-browser', binding: { session: 'dormouse.1.gui-abc', binaryPath: '/usr/bin/agent-browser' }, op: 'history', dir: 'reload',
    });

    // Params that predate that write — a remounted view feeding them before its
    // flush — do not take the session away and launch again.
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/', session: 'dormouse.1.gui-abc' });
    await flushMicrotasks();
    expect(host.requests('launch')).toHaveLength(1);
    expect(streamSockets(4321)).toHaveLength(1);
  });

  it('opens in the session params name, headed for a pop-out, and binds it', async () => {
    const host = launchHost(async () => ({ ok: true, session: 'dormouse.1.tool.t', stream: 4321 }));
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-popout', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t',
    });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    expect(host.requests('launch')).toEqual([{
      provider: 'agent-browser', binding: { session: 'dormouse.1.tool.t' }, op: 'launch', url: 'http://localhost:6006/', headed: true,
    }]);
    expect(sink.updateParameters).toHaveBeenCalledWith({ session: 'dormouse.1.tool.t', launchSession: undefined, launchFallback: undefined });
  });

  it('a failed launch says why, in the pane and to whoever awaited it', async () => {
    installBrowserHost({ launch: async () => ({ ok: false }) });
    const launched = whenBrowserLaunched('pw');
    const controller = acquireAgentBrowserSurfaceController('pw', { renderMode: 'pw-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(await launched).toBe('Could not open Playwright');
    expect(controller.snapshot()).toMatchObject({ phase: 'ended', error: 'Could not open Playwright' });
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  it('a Surface closed mid-launch closes the browser that comes up, and its waiter hears it is gone', async () => {
    const launch = pending();
    const host = launchHost(() => launch.promise);
    const launched = whenBrowserLaunched('id');
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();

    closeBrowserSurface('id', { surfaceType: 'browser', renderMode: 'ab-screencast', url: 'https://page.example/' });
    expect(await launched).toBeNull();
    expect(host.requests('close')).toEqual([]);

    launch.resolve({ ok: true, session: 'dormouse.1.gui-late', stream: 4321 });
    await flushMicrotasks();
    expect(host.requests('close')).toEqual([{ provider: 'agent-browser', binding: { session: 'dormouse.1.gui-late' }, op: 'close' }]);
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  it('a navigation out of a failed launch launches at its page, and loads it once', async () => {
    const answers: BrowserResult[] = [{ ok: false, error: 'boom' }, { ok: true, session: 'dormouse.1.gui-n', stream: 4321 }];
    const host = launchHost(async () => answers.shift()!);
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    await flushMicrotasks();
    expect(host.requests('launch').at(-1)).toEqual({ provider: 'agent-browser', binding: {}, op: 'launch', url: 'https://next.example/', headed: false });
    expect(streamSocket(4321)?.readyState).toBe(1);
    expect(opens(host)).toEqual([]);
  });

  it('a Tool re-framed while its browser opens goes to the new page once live', async () => {
    const launch = pending();
    const host = launchHost(() => launch.promise);
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-screencast', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t',
    });
    controller.attachView(makeSink());
    await flushMicrotasks();

    // A new announcement: the same session, another page.
    controller.updateParams({ renderMode: 'ab-screencast', url: 'http://localhost:6007/docs', launchSession: 'dormouse.1.tool.t' });
    launch.resolve({ ok: true, session: 'dormouse.1.tool.t', stream: 4321 });
    await flushMicrotasks();
    expect(streamSocket(4321)?.readyState).toBe(1);
    expect(opens(host)).toEqual(['http://localhost:6007/docs']);
  });

  it('ignores params that predate the session its launch bound', async () => {
    const host = launchHost(async () => ({ ok: true, session: 'dormouse.1.gui-abc', stream: 4321 }));
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();

    // A remounted view feeds the params it rendered with, before the write shows.
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/' });
    await flushMicrotasks();
    expect(host.requests('launch')).toHaveLength(1);
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('never closes the session a launch opened when the Surface has since bound it', async () => {
    const launch = pending();
    const host = launchHost(() => launch.promise);
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-screencast', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t',
    });
    controller.attachView(makeSink());
    await flushMicrotasks();

    controller.updateParams({ renderMode: 'ab-screencast', url: 'http://localhost:6006/', session: 'dormouse.1.tool.t' });
    controller.handOver(4321);
    launch.resolve({ ok: true, session: 'dormouse.1.tool.t', stream: 4321 });
    await flushMicrotasks();
    expect(host.requests('close')).toEqual([]);
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('launches with the binary `dor ab` last resolved, and remembers the one it ran', async () => {
    const host = launchHost(async () => ({ ok: true, session: 'dormouse.1.gui-b', stream: 4321, binaryPath: '/opt/ab/agent-browser' }));
    rememberLaunchBinaryPath('agent-browser', '/usr/local/bin/agent-browser');
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();
    expect(host.requests('launch')).toEqual([{
      provider: 'agent-browser', binding: { binaryPath: '/usr/local/bin/agent-browser' }, op: 'launch', url: 'https://page.example/', headed: false,
    }]);
    expect(launchBinaryPath('agent-browser')).toBe('/opt/ab/agent-browser');
  });

  it('tells the Wall about a failed launch, once a view is attached to hear it', async () => {
    launchHost(async () => ({ ok: false, error: 'boom' }));
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    const first = makeSink();
    const handle = controller.attachView(first);
    handle.detach();
    await flushMicrotasks();
    expect(first.launchFailed).not.toHaveBeenCalled();
    const second = makeSink();
    controller.attachView(second);
    expect(second.launchFailed).toHaveBeenCalledExactlyOnceWith('boom');
  });

  it('a launch released without a close leaves a session it named, and closes one the host minted', async () => {
    const answers: Array<(res: BrowserResult) => void> = [];
    const host = launchHost(() => new Promise((resolve) => { answers.push(resolve); }));
    const named = acquireAgentBrowserSurfaceController('named', { renderMode: 'ab-screencast', url: 'https://page.example/', launchSession: 'dormouse.1.tool.t' });
    named.attachView(makeSink());
    const minted = acquireAgentBrowserSurfaceController('minted', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    minted.attachView(makeSink());
    await flushMicrotasks();

    // A Workspace transfer: the destination opens the same named session.
    disposeAgentBrowserSurfaceController('named');
    disposeAgentBrowserSurfaceController('minted');
    answers[0]({ ok: true, session: 'dormouse.1.tool.t', stream: 4321 });
    answers[1]({ ok: true, session: 'dormouse.1.gui-x', stream: 4322 });
    await flushMicrotasks();
    expect(host.requests('close')).toEqual([{ provider: 'agent-browser', binding: { session: 'dormouse.1.gui-x' }, op: 'close' }]);
  });

  it('a controller released before it ever started still settles its waiter', async () => {
    launchHost(async () => ({ ok: true }));
    const launched = whenBrowserLaunched('id');
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    disposeAgentBrowserSurfaceController('id');
    expect(await launched).toBeNull();
  });

  it('a Surface killed before its view ever mounted still settles its waiter', async () => {
    launchHost(async () => ({ ok: true }));
    const launched = whenBrowserLaunched('never-mounted');
    closeBrowserSurface('never-mounted', { surfaceType: 'browser', renderMode: 'ab-screencast', url: 'https://page.example/' });
    expect(await launched).toBeNull();
  });
});

describe('a closed Surface and the next launch into its session', () => {
  // A Tool swapped to its embed and back, or re-framed after its dev server
  // restarts, while its browser was still coming up: the Surface closes, and
  // the next launch opens the same `tool.<leafId>` session. The host orders
  // the two (docs/specs/dor-browser.md → "Browser Host"), so these run the
  // controller against the real one.
  const session = 'dormouse.1.tool.t';
  const page = 'http://localhost:6006/';
  /** `deliver` stands in for the transport: it hands a request to the host,
   *  by default at once. */
  function realHost(deliver: (request: BrowserRequest, send: () => Promise<BrowserResult>) => Promise<BrowserResult> = (_request, send) => send()) {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const browser = vi.fn((request: BrowserRequest) => deliver(request, () => host.request(request)));
    setPlatform(Object.assign(new FakePtyAdapter(), { browserProviders: ['agent-browser'] as const, browser }));
    // What the host did to the session's browser: bring it up, or close it.
    const lifecycle = () => fake.calls.filter((call) => /^(stop|open|close) /.test(call));
    return { fake, browser, lifecycle };
  }
  /** `id`'s work into the session is held in the host (at its `stop`): close
   *  `id`, start the next launch into the session, let the work land, and
   *  check the close came after it and the next launch after the close. */
  async function expectNextLaunchAfterClose(host: ReturnType<typeof realHost>, id: string, work: string[]) {
    void closeBrowserSurface(id, {});
    const next = acquireAgentBrowserSurfaceController('next', { renderMode: 'ab-screencast', url: page, launchSession: session });
    next.attachView(makeSink());
    await flushMicrotasks();
    expect(host.lifecycle()).toEqual([`stop ${session}`]);

    host.fake.release(`stop ${session}`);
    await vi.waitFor(() => expect(next.snapshot().phase).toBe('live'));
    expect(host.lifecycle()).toEqual([...work, `close ${session}`, `stop ${session}`, `open ${session} ${page}`]);
  }

  it.each([
    ['bound to the session', false],
    ['still launching it', true],
  ])('sends the next launch only once the close of a Surface %s is answered, on a transport that delivers the launch first', async (_name, launching) => {
    // Tauri runs each command on a worker pool, so a close and a launch sent
    // an instant apart can reach the host in either order.
    let deliverClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => { deliverClose = resolve; });
    const host = realHost((request, send) => (request.op === 'close' ? closeHeld.then(send) : send()));
    if (launching) {
      host.fake.gate(`stop ${session}`);
      acquireAgentBrowserSurfaceController('first', { renderMode: 'ab-screencast', url: page, launchSession: session }).attachView(makeSink());
    } else {
      withPort('first', { session, url: page }, 1111).attachView(makeSink());
    }
    await flushMicrotasks();
    const firstWork = launching ? [`stop ${session}`] : [];

    void closeBrowserSurface('first', {});
    const next = acquireAgentBrowserSurfaceController('next', { renderMode: 'ab-screencast', url: page, launchSession: session });
    next.attachView(makeSink());
    await flushMicrotasks();
    // The close is still on its way, so the next launch has not been sent.
    const sent = () => host.browser.mock.calls.map(([request]) => request.op).filter((op) => op === 'close' || op === 'launch');
    expect(sent()).toEqual([...(launching ? ['launch'] : []), 'close']);
    expect(host.lifecycle()).toEqual(firstWork);

    deliverClose();
    if (launching) host.fake.release(`stop ${session}`);
    await vi.waitFor(() => expect(next.snapshot().phase).toBe('live'));
    expect(host.lifecycle()).toEqual([
      ...(launching ? [`stop ${session}`, `open ${session} ${page}`] : []),
      `close ${session}`, `stop ${session}`, `open ${session} ${page}`,
    ]);
  });

  it.each([
    ['launch naming it', 'launch'],
    ['pop-out', 'launch'],
    ['attach relaunching it', 'attach'],
  ] as const)('a Surface closed while its own %s is on its way opens nothing, though the close reaches the host first', async (name, op) => {
    // Tauri runs each command on a worker pool, so a request sent an instant
    // before the close can reach the host after it.
    let deliver!: () => void;
    const held = new Promise<void>((resolve) => { deliver = resolve; });
    const host = realHost((request, send) => (request.op === op ? held.then(send) : send()));
    if (name === 'launch naming it') {
      acquireAgentBrowserSurfaceController('first', { renderMode: 'ab-screencast', url: page, launchSession: session }).attachView(makeSink());
    } else if (name === 'pop-out') {
      const first = withPort('first', { session, url: page }, 1111);
      first.attachView(makeSink());
      await flushMicrotasks();
      first.setRenderMode('ab-popout');
    } else {
      acquireAgentBrowserSurfaceController('first', { session, url: page }).attachView(makeSink());
    }
    await flushMicrotasks();
    const sent = host.browser.mock.calls.map(([request]) => request).find((request) => request.op === op) as { requestId?: string };
    expect(sent.requestId).toEqual(expect.any(String));

    await closeBrowserSurface('first', {});
    expect(host.browser.mock.calls.map(([request]) => request).find((request) => request.op === 'close')).toMatchObject({ cancels: [sent.requestId] });
    deliver();
    // Every request answered, the late one included.
    await Promise.all(host.browser.mock.results.map(({ value }) => value));
    expect(host.lifecycle()).toEqual([`close ${session}`]);
  });

  it('closes a launch that was opening it before the next launch', async () => {
    const host = realHost();
    host.fake.gate(`stop ${session}`);
    acquireAgentBrowserSurfaceController('first', { renderMode: 'ab-screencast', url: page, launchSession: session })
      .attachView(makeSink());
    await flushMicrotasks();
    await expectNextLaunchAfterClose(host, 'first', [`stop ${session}`, `open ${session} ${page}`]);
  });

  it('a launch closed before its turn opens nothing', async () => {
    const host = realHost();
    host.fake.gate(`stop ${session}`);
    acquireAgentBrowserSurfaceController('first', { renderMode: 'ab-screencast', url: page, launchSession: session })
      .attachView(makeSink());
    await flushMicrotasks();
    void closeBrowserSurface('first', {});
    acquireAgentBrowserSurfaceController('next', { renderMode: 'ab-screencast', url: page, launchSession: session })
      .attachView(makeSink());
    await flushMicrotasks();
    // Swapped away again before the first launch landed.
    const closed = closeBrowserSurface('next', {});
    host.fake.release(`stop ${session}`);
    await closed;
    expect(host.lifecycle()).toEqual([`stop ${session}`, `open ${session} ${page}`, `close ${session}`, `close ${session}`]);
  });

  it('closes a pop-out that was relaunching it before the next launch', async () => {
    const host = realHost();
    const first = withPort('first', { session, url: page }, 1111);
    first.attachView(makeSink());
    await flushMicrotasks();
    host.fake.gate(`stop ${session}`);
    first.setRenderMode('ab-popout');
    await flushMicrotasks();
    await expectNextLaunchAfterClose(host, 'first', [`stop ${session}`, `open ${session} ${page} headed`]);
  });

  it('closes an attach that was relaunching it before the next launch', async () => {
    const host = realHost();
    // Gone, but its name still held: the relaunch stops it first.
    host.fake.provider.find = async () => ({ gone: 'not running', named: true });
    host.fake.gate(`stop ${session}`);
    acquireAgentBrowserSurfaceController('first', { session, url: page }).attachView(makeSink());
    await flushMicrotasks();
    expect(host.browser).toHaveBeenCalledWith(expect.objectContaining({ op: 'attach', url: page }));
    await expectNextLaunchAfterClose(host, 'first', [`stop ${session}`, `open ${session} ${page}`]);
  });
});

describe('attach', () => {
  function attachHost(attach: NonNullable<BrowserAnswers['attach']>) {
    return installBrowserHost({ attach });
  }

  it('a restored pane attaches at the page and presentation it had', async () => {
    const host = attachHost(async () => ({ ok: true, stream: 2222 }));
    const controller = acquireAgentBrowserSurfaceController('id', {
      session: 'sess', renderMode: 'ab-popout', url: 'https://restored.example/',
    });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    expect(host.requests('attach')).toEqual([onSess({ op: 'attach', url: 'https://restored.example/', headed: true })]);
    expect(streamSocket(2222)?.readyState).toBe(1);
  });

  it('streams from a port `dor` hands over, out of `ended` too', async () => {
    attachHost(async () => ({ ok: false, error: 'not running' }));
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('ended');

    handOverBrowserStream('id', { session: 'sess', url: 'https://page.example/' }, 4321);
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('a browser that cannot be reopened says why', async () => {
    attachHost(async () => ({ ok: false, error: 'agent-browser binary not found' }));
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://restored.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(controller.snapshot()).toMatchObject({ phase: 'ended', error: 'agent-browser binary not found' });
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  /** A live pane on 1111, parked. */
  async function parkedAt1111(attach: NonNullable<BrowserAnswers['attach']>) {
    const host = attachHost(attach);
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    controller.attachView(makeSink());
    await vi.advanceTimersByTimeAsync(0);
    expect(streamSocket(1111)?.readyState).toBe(1);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
    expect(controller.isParked()).toBe(true);
    expect(streamSocket(1111)?.readyState).toBe(3);
    return { host, controller };
  }

  it('never attaches while parked, and an unpark whose port still answers asks the host nothing', async () => {
    vi.useFakeTimers();
    try {
      const { host, controller } = await parkedAt1111(async () => ({ ok: true, stream: 2222 }));
      // Hidden and shown again, a headless pane never left `live` for its view.
      expect(controller.snapshot().phase).toBe('live');
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(streamSockets(1111)).toHaveLength(2);
      expect(streamSocket(1111)?.readyState).toBe(1);
      expect(host.requests('attach')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unpark whose port fails asks the host, without a page, where the stream moved', async () => {
    vi.useFakeTimers();
    try {
      const { host, controller } = await parkedAt1111(async () => ({ ok: true, stream: 2222 }));
      WebSocketMock.failPorts.add(1111);
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      // Without a page: a daemon gone while hidden has ended, it is not
      // relaunched behind the user's back.
      expect(host.requests('attach')).toEqual([onSess({ op: 'attach', url: undefined, headed: false })]);
      expect(streamSocket(2222)?.readyState).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['answers', true, false],
    ['answers, with a page asked for meanwhile', true, true],
    ['has gone away', false, true],
  ])('an unpark catches up only once the port it parked at %s', async (_name, answers, askedMeanwhile) => {
    vi.useFakeTimers();
    try {
      const host = attachHost(async () => ({ ok: false, error: 'not running' }));
      // What reaches the browser: a stream URL is only the host's to build.
      const sent = () => host.browser.mock.calls.map(([request]) => request).filter((request) => request.op !== 'view');
      const sink = makeSink();
      let size = { width: 800, height: 600 };
      sink.viewport.getBoundingClientRect = () => ({ ...size }) as DOMRect;
      const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);
      // While hidden: the Door comes back at another size, and a page is asked for.
      size = { width: 1000, height: 700 };
      getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
      host.browser.mockClear();

      // The resize and the page asked for while hidden wait for the stream, so
      // a daemon gone meanwhile is found ended rather than driven.
      if (!answers) WebSocketMock.failPorts.add(1111);
      controller.setVisible(true);
      // Asked for before the stream opens: sent at once — the host refuses it
      // if the daemon is gone — superseding the page asked for while hidden.
      if (askedMeanwhile) getAgentBrowserScreenController('id')!.chromeActions.navigate('https://later.example/');
      await vi.advanceTimersByTimeAsync(250);
      const later = askedMeanwhile ? [onSess({ op: 'navigate', url: 'https://later.example/' })] : [];
      if (answers) {
        expect(sent()).toEqual([
          ...later,
          onSess({ op: 'viewport', width: 1000, height: 700, dpr: 1 }),
          ...(askedMeanwhile ? [] : [onSess({ op: 'navigate', url: 'https://next.example/' })]),
        ]);
      } else {
        expect(sent()).toEqual([...later, onSess({ op: 'attach', headed: false })]);
        expect(controller.snapshot().phase).toBe('ended');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unpark the host cannot place ends', async () => {
    vi.useFakeTimers();
    try {
      const { controller } = await parkedAt1111(async () => ({ ok: false, error: 'not running' }));
      WebSocketMock.failPorts.add(1111);
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.snapshot()).toMatchObject({ phase: 'ended', error: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a headless browser that drops ends, reached again only through attach or a handed-over port', async () => {
    const host = attachHost(async () => ({ ok: true, stream: 3333 }));
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    const socket = streamSocket(1111)!;
    // Not yet reported connected: still coming up, not gone.
    socket.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    expect(controller.snapshot().phase).toBe('live');
    socket.emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: true }));
    socket.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    expect(controller.snapshot().phase).toBe('ended');
    expect(socket.readyState).toBe(3);
    expect(host.requests('attach')).toEqual([]);

    // `dor ab open` brings it back on the port it had.
    handOverBrowserStream('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSockets(1111)).toHaveLength(2);

    // Ended again, a URL-bar navigation attaches — never a daemon command, which
    // would start a daemon on a port nobody learns. Its daemon was still up, so
    // attach only found it: the page opens once live.
    streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: true }));
    streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    expect(host.requests('navigate')).toEqual([]);
    expect(host.requests('attach')).toEqual([onSess({ op: 'attach', url: 'https://next.example/', headed: false })]);
    await flushMicrotasks();
    expect(streamSocket(3333)?.readyState).toBe(1);
    expect(host.requests('navigate')).toEqual([onSess({ op: 'navigate', url: 'https://next.example/' })]);
  });

  it('a navigation that relaunches a gone daemon loads its page once', async () => {
    const host = attachHost(async () => ({ ok: false, error: 'not running' }));
    acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();
    host.answers.attach = async () => ({ ok: true, stream: 3333, relaunched: true });

    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    await flushMicrotasks();
    expect(host.requests('attach').at(-1)).toEqual(onSess({ op: 'attach', url: 'https://next.example/', headed: false }));
    expect(streamSocket(3333)?.readyState).toBe(1);
    expect(opens(host)).toEqual([]);
  });

  it('does not query the daemon while a relaunch is in flight', async () => {
    const host = attachHost(async () => ({ ok: true, stream: 9999 }));
    host.answers.launch = () => new Promise<never>(() => {});

    const controller = withPort('id', { session: 'sess' }, 1111);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    expect(host.requests('launch')).toEqual([onSess({ op: 'launch', url: undefined, headed: true })]);
    host.browser.mockClear();

    // A stream drop mid-relaunch must not spawn a competing daemon.
    streamSocket(1111)?.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    await flushMicrotasks();
    expect(host.browser).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('tears down the socket, timers, and screen registration', async () => {
    const controller = withPort('id', { session: 'sess' }, 1111);
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

describe('closeBrowserSurface', () => {
  function closeHost() {
    const popOut = pending();
    const host = installBrowserHost({ launch: () => popOut.promise });
    const closes = () => host.requests('close');
    return { host, closes, resolvePopOut: popOut.resolve };
  }

  it('closes the session once, at once, even with a relaunch in flight', async () => {
    const { closes, resolvePopOut } = closeHost();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');

    closeBrowserSurface('id', { renderMode: 'ab-popout', session: 'sess' });
    expect(closes()).toHaveLength(1);
    expect(getAgentBrowserSurfaceController('id')).toBeNull();

    // The host runs that close after the relaunch, so closing again when it
    // lands would close whoever launched the session next.
    resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(closes()).toHaveLength(1);
    expect(streamSockets(3456)).toHaveLength(0);
  });

  it('closes the session a launch names, at once', async () => {
    const launch = pending();
    const host = installBrowserHost({ launch: () => launch.promise });
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t', binaryPath: '/opt/agent-browser' })
      .attachView(makeSink());
    await flushMicrotasks();

    void closeBrowserSurface('id', {});
    // Through the binding the launch used, so the host orders the two.
    expect(host.requests('close')).toEqual([{ provider: 'agent-browser', binding: host.requests('launch')[0].binding, op: 'close' }]);
    expect(host.requests('close')[0].binding).toMatchObject({ session: 'dormouse.1.tool.t', binaryPath: '/opt/agent-browser' });
    launch.resolve({ ok: true, session: 'dormouse.1.tool.t', stream: 4321 });
    await flushMicrotasks();
    expect(host.requests('close')).toHaveLength(1);
  });

  it('cancels only its own requests the host has not answered', async () => {
    const popIn = pending();
    const answers = [Promise.resolve<BrowserResult>({ ok: true, stream: 3456 }), popIn.promise];
    const host = installBrowserHost({ launch: () => answers.shift()! });
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    // A pop-out the host answered, then a pop-in still on its way.
    controller.setRenderMode('ab-popout');
    await flushMicrotasks();
    controller.setRenderMode('ab-screencast');
    await flushMicrotasks();

    void closeBrowserSurface('id', {});
    const sent = host.browser.mock.calls.map(([request]) => request as BrowserRequest & { requestId?: string; cancels?: string[] });
    const [popOut, pendingPopIn] = sent.filter((request) => request.op === 'launch');
    expect(popOut.requestId).not.toBe(pendingPopIn.requestId);
    expect(sent.find((request) => request.op === 'close')?.cancels).toEqual([pendingPopIn.requestId]);
  });

  it('a release that closes nothing leaves a relaunch in flight to whoever holds the session next', async () => {
    const { closes, resolvePopOut } = closeHost();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');

    disposeAgentBrowserSurfaceController('id');
    resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(closes()).toHaveLength(0);
  });

  it('closes a session no controller holds from its params, with only a checked binary', async () => {
    const { host } = closeHost();
    closeBrowserSurface('never-mounted', { surfaceType: 'browser', renderMode: 'ab-screencast', session: 'sess', binaryPath: '/usr/bin/curl' });
    closeBrowserSurface('iframe', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/' });
    expect(host.browser).toHaveBeenCalledExactlyOnceWith(onSess({ op: 'close' }));
  });
});

describe('relaunch (pop-out / pop-in)', () => {
  /** A host whose pop-out (a headed relaunch) waits for `resolvePopOut`, and
   *  whose pop-in answers port 5555. */
  function relaunchHost() {
    const popOut = pending();
    const host = installBrowserHost({
      attach: async () => ({ ok: true, stream: 9999 }),
      launch: (request) => request.headed ? popOut.promise : Promise.resolve({ ok: true, stream: 5555 }),
    });
    /** The relaunches of a bound session, headed (pop-outs) or not (pop-ins). */
    const relaunches = (headed: boolean) => host.requests('launch').filter((request) => request.binding.session !== undefined && request.headed === headed);
    return { ...host, resolvePopOut: popOut.resolve, relaunches };
  }

  it('drops the stream up front and connects to the host\'s port only once the relaunch ends', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess' }, 1111);
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
    expect(controller.snapshot().phase).toBe('relaunching');
    expect(controller.snapshot().poppedOut).toBe(true);
    // No viewer socket while the relaunch is in flight, headed or not.
    expect(host.requests('view')).toEqual([onSess({ op: 'view', stream: 1111 })]);

    host.resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSockets(3456).length).toBe(1);
    expect(streamSockets(1111).length).toBe(1);
    // The popped-out window's viewer: its page and its close, no frames.
    expect(host.requests('view').at(-1)).toEqual(onSess({ op: 'view', stream: 3456, headed: true }));
    expect(host.requests('attach')).toEqual([]);
  });

  it('ignores a second pop-out or pop-in while one is in flight', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    controller.popIn();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    await flushMicrotasks();

    expect(host.relaunches(true)).toHaveLength(1);
    expect(host.relaunches(false)).toHaveLength(0);
    expect(controller.snapshot().poppedOut).toBe(true);

    host.resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    controller.popIn();
    expect(host.relaunches(false)).toHaveLength(1);
  });

  it('pop-in while the first launch is in flight is a no-op', async () => {
    const host = relaunchHost();
    // The first launch opens a new session, and never answers.
    host.answers.launch = () => new Promise<never>(() => {});
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-popout', url: 'https://page.example/' });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    controller.popIn();
    expect(host.requests('launch')).toEqual([{ provider: 'agent-browser', binding: {}, op: 'launch', url: 'https://page.example/', headed: true }]);
    expect(controller.snapshot()).toMatchObject({ poppedOut: true, phase: 'launching' });
    expect(sink.updateParameters).not.toHaveBeenCalledWith({ renderMode: 'ab-screencast' });
  });

  it('a relaunch carries the URL the stream committed, not the one the last tabs snapshot reported', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://before.example/' }, 1111);
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
    expect(host.relaunches(true)).toEqual([onSess({ op: 'launch', url: 'https://slow.example/', headed: true })]);
  });

  it('relaunches at the last page the host can reopen, not a file: or data: tab', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://before.example/' }, 1111);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    const socket = streamSocket(1111);
    socket?.emitMessage(JSON.stringify({ type: 'url', url: 'https://app.example/report' }));
    socket?.emitMessage(JSON.stringify({ type: 'url', url: 'file:///tmp/report.html' }));
    // The header shows the page; the restorable URL stays the last http(s) one.
    expect(getAgentBrowserScreenController('id')?.chrome().url).toBe('file:///tmp/report.html');
    expect(sink.updateParameters).not.toHaveBeenCalledWith({ url: 'file:///tmp/report.html' });

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    expect(host.relaunches(true)).toEqual([onSess({ op: 'launch', url: 'https://app.example/report', headed: true })]);
  });

  it('clears a stale title when navigation commits at the same URL', async () => {
    const controller = withPort('id', {
      session: 'sess', url: 'https://same.example/',
    }, 1111);
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

  it('reaches no daemon from the header, Display modal, tabs, sync or edit chords mid-relaunch, and carries a navigation to the new browser', async () => {
    const host = relaunchHost();
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    vi.useFakeTimers();
    try {
      const controller = withPort('id', { session: 'sess' }, 1111);
      const sink = makeSink();
      let size = { width: 800, height: 600 };
      sink.viewport.getBoundingClientRect = () => ({ ...size }) as DOMRect;
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      streamSocket(1111)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [
          { tabId: 't1', title: 'One', url: 'https://one.example/', active: true },
          { tabId: 't2', title: 'Two', url: 'https://two.example/', active: false },
        ],
      }));
      const screen = getAgentBrowserScreenController('id')!;
      screen.actions.setRenderMode?.('ab-popout');
      expect(host.relaunches(true)).toHaveLength(1);
      host.browser.mockClear();

      screen.chromeActions.back();
      screen.chromeActions.forward();
      screen.chromeActions.reload();
      screen.chromeActions.navigate('https://first.example/');
      screen.chromeActions.navigate('https://latest.example/');
      screen.actions.applyDevice('iPhone 16 Pro');
      screen.actions.applyViewport(1024, 768, 2);
      screen.actions.engageSync();
      const [first, second] = controller.snapshot().tabs;
      controller.selectTab(second);
      controller.closeTab(first);
      size = { width: 900, height: 700 };
      observers.at(-1)?.([{ contentRect: { width: 900, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
      await vi.advanceTimersByTimeAsync(250);
      controller.handleKeyDownLike({ key: 'a', code: 'KeyA', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
      await vi.advanceTimersByTimeAsync(0);
      // Nothing at all reaches the host: no command, no edit, no capture.
      expect(host.browser).not.toHaveBeenCalled();

      // The relaunch lands: only the latest navigation runs, once.
      host.resolvePopOut({ ok: true, stream: 3456 });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.requests('navigate')).toEqual([onSess({ op: 'navigate', url: 'https://latest.example/' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sync-to-pane out of a pop-in gap, and re-syncs once the headless browser streams', async () => {
    const host = relaunchHost();
    const popIn = pending();
    host.answers.launch = () => popIn.promise;
    const controller = withPort('id', { session: 'sess', renderMode: 'ab-popout' }, 1111);
    const sink = makeSink();
    sink.viewport.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    controller.attachView(sink);
    await flushMicrotasks();

    controller.popIn();
    // Headless already, as far as the view is concerned — but not yet live.
    expect(controller.snapshot().poppedOut).toBe(false);
    window.dispatchEvent(new Event('resize'));
    getAgentBrowserScreenController('id')!.actions.engageSync();
    expect(host.requests('viewport')).toEqual([]);

    popIn.resolve({ ok: true, stream: 5555 });
    await flushMicrotasks();
    expect(host.requests('viewport')).toEqual([onSess({ op: 'viewport', width: 800, height: 600, dpr: 1 })]);
  });

  /** A popped-out pane live at 1111 whose window reported `statuses`, the
   *  pane itself 800×600; its pop-in waits for `resolvePopIn`. */
  async function poppedOut(...statuses: object[]) {
    const host = relaunchHost();
    const popIn = pending();
    host.answers.launch = (request) => request.headed ? Promise.resolve({ ok: true, stream: 3456 }) : popIn.promise;
    const controller = withPort('id', { session: 'sess', renderMode: 'ab-popout', url: 'https://page.example/' }, 1111);
    const sink = makeSink();
    sink.viewport.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    controller.attachView(sink);
    await flushMicrotasks();
    for (const status of statuses) streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', screencasting: false, ...status }));
    return { host, controller, sink, resolvePopIn: popIn.resolve };
  }

  it.each([
    ['its window closes', () => streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }))],
    ['Pop back in is pressed', () => getAgentBrowserSurfaceController('id')!.popIn()],
  ])('a pop-in when %s fixes the screencast at the window\'s last resolution, once the headless browser is live', async (_name, popIn) => {
    const { host, sink, resolvePopIn } = await poppedOut(
      // The daemon's configured viewport, which the window does not follow.
      { connected: true, viewportWidth: 1280, viewportHeight: 720 },
      { connected: true, viewportWidth: 1100, viewportHeight: 657, devicePixelRatio: 2 },
      // Resized, then moved to another display.
      { connected: true, viewportWidth: 1200, viewportHeight: 736, devicePixelRatio: 1.5 },
    );
    popIn();
    expect(host.relaunches(false)).toEqual([onSess({ op: 'launch', url: 'https://page.example/', headed: false })]);
    expect(sink.updateParameters).toHaveBeenCalledWith({ syncEngaged: false });
    // Nothing reaches the browser the relaunch is replacing.
    expect(host.requests('viewport')).toEqual([]);

    resolvePopIn({ ok: true, stream: 5555 });
    await flushMicrotasks();
    expect(host.requests('viewport')).toEqual([onSess({ op: 'viewport', width: 1200, height: 736, dpr: 1.5 })]);
    // The Display modal shows Fixed, at those numbers.
    expect(getAgentBrowserScreenController('id')!.snapshot()).toMatchObject({
      renderMode: 'ab-screencast', syncEngaged: false, viewport: { w: 1200, h: 736, dpr: 1.5 },
    });
  });

  it('a resolution picked during the pop-in wins, and a fixed ratio describes only the browser it was set on', async () => {
    const { host, controller, resolvePopIn } = await poppedOut({ connected: true, viewportWidth: 1200, viewportHeight: 736, devicePixelRatio: 1.5 });
    const screen = getAgentBrowserScreenController('id')!;
    controller.popIn();
    screen.actions.engageSync();
    resolvePopIn({ ok: true, stream: 5555 });
    await flushMicrotasks();
    expect(host.requests('viewport')).toEqual([onSess({ op: 'viewport', width: 800, height: 600, dpr: 1 })]);

    // The modal reports the ratio it fixed, until another resolution is picked.
    for (const pick of [() => screen.actions.engageSync(), () => screen.actions.applyDevice('iPhone 16')]) {
      screen.actions.applyViewport(1024, 768, 3);
      expect(screen.snapshot()).toMatchObject({ syncEngaged: false, viewport: { dpr: 3 } });
      pick();
      expect(screen.snapshot()?.viewport.dpr).toBe(1);
    }
    // Or until another browser streams.
    screen.actions.applyViewport(1024, 768, 3);
    controller.handOver(4321);
    await flushMicrotasks();
    emitFrame(streamSocket(4321), 'provisional', 1, { width: 1024, height: 768 });
    expect(screen.snapshot()?.viewport.dpr).toBe(1);
  });

  it('a fixed resolution picked while a pop-out opens never sizes the window', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    const screen = getAgentBrowserScreenController('id')!;
    screen.actions.setRenderMode?.('ab-popout');
    screen.actions.applyViewport(1024, 768, 2);
    host.resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(controller.snapshot()).toMatchObject({ poppedOut: true, phase: 'live' });
    expect(host.requests('viewport')).toEqual([]);
  });

  it('a pop-in with no resolution from this window keeps resizing with the pane', async () => {
    const { host, controller, resolvePopIn } = await poppedOut({ connected: true, viewportWidth: 1100, viewportHeight: 657, devicePixelRatio: 2 });
    controller.popIn();
    resolvePopIn({ ok: true, stream: 5555 });
    await flushMicrotasks();
    const screen = getAgentBrowserScreenController('id')!;
    screen.actions.engageSync();
    host.browser.mockClear();

    // Out again: this window reports only the daemon's viewport.
    screen.actions.setRenderMode?.('ab-popout');
    await flushMicrotasks();
    streamSocket(3456)!.emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: false, viewportWidth: 1280, viewportHeight: 720 }));
    host.answers.launch = (request) => Promise.resolve({ ok: true, stream: request.headed ? 3456 : 5556 });
    controller.popIn();
    await flushMicrotasks();
    expect(host.requests('viewport')).toEqual([onSess({ op: 'viewport', width: 800, height: 600, dpr: 1 })]);
    expect(screen.snapshot()).toMatchObject({ syncEngaged: true, viewport: { dpr: 1 } });
  });

  it('a pop-out asked for with a page relaunches there instead of navigating into the gap', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://before.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();

    // The pane context menu's reuse of an existing port target.
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout', { url: 'http://localhost:5173/' });
    expect(host.relaunches(true)).toEqual([onSess({ op: 'launch', url: 'http://localhost:5173/', headed: true })]);
    host.resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(host.requests('navigate')).toEqual([]);
  });

  it('a navigation to the page a relaunch is opening loads it once', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://page.example/');
    host.resolvePopOut({ ok: true, stream: 3456 });
    await flushMicrotasks();
    expect(host.relaunches(true)).toEqual([expect.objectContaining({ url: 'https://page.example/' })]);
    expect(opens(host)).toEqual([]);
  });

  it.each([
    ['the page asked for while it was parked', undefined, 'https://next.example/'],
    ['the page it asks for, over one asked for earlier', 'http://localhost:5173/', 'http://localhost:5173/'],
  ])('a pop-out from a parked pane opens %s, once', async (_name, asked, opened) => {
    vi.useFakeTimers();
    try {
      const host = relaunchHost();
      const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
      controller.attachView(makeSink());
      await vi.advanceTimersByTimeAsync(0);
      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);

      getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
      getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout', asked ? { url: asked } : undefined);
      expect(host.relaunches(true)).toEqual([expect.objectContaining({ url: opened })]);
      host.resolvePopOut({ ok: true, stream: 3456 });
      await vi.advanceTimersByTimeAsync(0);
      expect(opens(host)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pop-out asked for before the browser is bound, and runs it with its page once live', async () => {
    const host = relaunchHost();
    const attach = pending();
    host.answers.attach = () => attach.promise;
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' });
    // Before any view mounts it, as for a Door the context menu reveals.
    controller.setRenderMode('ab-popout', { url: 'http://localhost:5173/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(host.requests('attach')).toHaveLength(1);
    expect(host.relaunches(true)).toEqual([]);

    attach.resolve({ ok: true, stream: 1111 });
    await flushMicrotasks();
    expect(host.relaunches(true)).toEqual([onSess({ op: 'launch', url: 'http://localhost:5173/', headed: true })]);
  });

  it('a failed pop-out comes back in the pane, relaunching headless at its page if no daemon came up', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    host.resolvePopOut({ ok: false });
    await flushMicrotasks();
    expect(host.requests('attach')).toEqual([onSess({ op: 'attach', url: 'https://page.example/', headed: false })]);
    expect(sink.updateParameters).toHaveBeenLastCalledWith({ renderMode: 'ab-screencast' });
    expect(controller.snapshot()).toMatchObject({ poppedOut: false, phase: 'live' });
    expect(streamSocket(9999)?.readyState).toBe(1);
  });

  it('a `dor ab` re-run handing over a new port reconnects there and asks the daemon nothing', async () => {
    const host = relaunchHost();
    const controller = withPort('id', { session: 'sess', url: 'https://x.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(streamSocket(1111)?.readyState).toBe(1);

    controller.handOver(4321);
    await flushMicrotasks();
    expect(streamSocket(1111)?.readyState).toBe(3);
    expect(streamSockets(4321)).toHaveLength(1);
    expect(host.requests('attach')).toEqual([]);
  });
});

describe('Playwright provider', () => {
  it('pastes as whole-text messages the host inserts, not a key pair per character', async () => {
    const host = installBrowserHost();
    const pasted = `${'x'.repeat(VIEWER_TEXT_INPUT_MAX + 10)}\r\nend`;
    (host.platform as PlatformAdapter).readClipboardText = vi.fn(async () => pasted);
    const controller = withPort('pw', { renderMode: 'pw-screencast', session: 's' }, 4321);
    controller.attachView(makeSink());
    await flushMicrotasks();

    controller.handleKeyDownLike({ key: 'v', code: 'KeyV', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    await flushMicrotasks();

    // Two messages, where a key pair per character was ~16k: the host's input
    // queue closes the viewer at 256.
    const sent = streamSocket(4321)!.sent.map((raw) => JSON.parse(raw) as { type: string; text: string });
    expect(sent.map((message) => message.type)).toEqual(['input_text', 'input_text']);
    expect(sent.map((message) => message.text).join('')).toBe(pasted.replace('\r\n', '\n'));
  });

  it('names Playwright in a failed host command warning', async () => {
    installBrowserHost({ history: async () => ({ ok: false, error: 'boom' }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = withPort('pw', { renderMode: 'pw-screencast', session: 's' }, 4321);
    controller.attachView(makeSink());
    getAgentBrowserScreenController('pw')!.chromeActions.reload();
    await flushMicrotasks();
    expect(warn).toHaveBeenCalledWith('[playwright] reload failed:', 'boom');
  });

  it('uses the shared controller with provider-scoped host calls and cwd', async () => {
    // The swap back to agent-browser is offered only where the host can launch one.
    const host = installBrowserHost();
    const controller = withPort('pw', { renderMode: 'pw-screencast', session: 'shared-name', cwd: '/first-project' }, 4321);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    getAgentBrowserScreenController('pw')!.chromeActions.navigate('https://example.com/next');
    await flushMicrotasks();
    expect(host.requests('navigate')).toEqual([{
      provider: 'playwright', binding: { session: 'shared-name', cwd: '/first-project' }, op: 'navigate', url: 'https://example.com/next',
    }]);
    expect(host.browser.mock.calls.filter(([request]) => request.provider !== 'playwright')).toEqual([]);
    expect(getAgentBrowserScreenController('pw')!.snapshot().renderMode).toBe('pw-screencast');
    getAgentBrowserScreenController('pw')!.actions.setRenderMode?.('ab-screencast');
    expect(sink.requestRenderSwap).toHaveBeenCalledWith('ab-screencast');
    controller.updateParams({ renderMode: 'pw-popout', session: 'shared-name', cwd: '/first-project' });
    expect(getAgentBrowserScreenController('pw')!.snapshot().renderMode).toBe('pw-popout');
  });
});
