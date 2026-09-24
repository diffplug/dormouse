/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { PLAYWRIGHT_TEXT_INPUT_MAX } from '../../lib/platform/browser-automation';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { forgetLaunchBinaryPaths, launchBinaryPath, rememberLaunchBinaryPath } from './browser-automation';
import {
  HIDDEN_PARK_DELAY_MS,
  PROVISIONAL_INPUT_WINDOW_MS,
  acquireAgentBrowserSurfaceController,
  closeBrowserSurface,
  disposeAgentBrowserSurfaceController,
  handOverBrowserPort,
  whenBrowserLaunched,
  type AgentBrowserSurfaceController,
  type AgentBrowserSurfaceParams,
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

/** A controller whose first start streams from `port`, as `dor ab` hands
 *  one over. */
function withPort(id: string, params: AgentBrowserSurfaceParams, port: number): AgentBrowserSurfaceController {
  const controller = acquireAgentBrowserSurfaceController(id, params);
  controller.handOver(port);
  return controller;
}

/** The pages a controller opened with a daemon command, in order. */
const opens = (platform: Pick<PlatformAdapter, 'agentBrowserCommand'>) =>
  vi.mocked(platform.agentBrowserCommand!).mock.calls.filter(([, args]) => args[0] === 'open').map(([, args]) => args[1]);

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

describe('provisional stream paint', () => {
  type Shot = { ok: true; bytes: Uint8Array; mime: string };
  /** An attached pane on `sess:4321` with the clock, the host capture and the
   *  canvas under the test's control. Captures never answer unless `screenshot` says. */
  async function paintFixture(
    screenshot: () => Promise<Shot> = () => new Promise<never>(() => {}),
    extra: Partial<Pick<PlatformAdapter, 'agentBrowserEdit' | 'readClipboardText'>> = {},
  ) {
    const clock = { now: 1000 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const platform = Object.assign(new FakePtyAdapter(), { agentBrowserScreenshot: vi.fn(screenshot), ...extra });
    setPlatform(platform);
    const bitmap = { width: 40, height: 30, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const sink = makeSink();
    const drawImage = vi.fn();
    sink.canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof sink.canvas.getContext;
    const controller = withPort('id', { session: 'sess' }, 4321);
    controller.attachView(sink);
    await flushMicrotasks();
    const frame = async (label: string) => {
      streamSocket(4321)?.emitMessage(JSON.stringify({ type: 'frame', data: btoa(label), metadata: { deviceWidth: 40, deviceHeight: 30 } }));
      await flushMicrotasks();
    };
    const decodes = () => vi.mocked(createImageBitmap).mock.calls.length;
    return { clock, platform, sink, bitmap, drawImage, controller, frame, decodes };
  }

  it('draws the native stream frame before the crisp screenshot resolves', async () => {
    const { clock, platform, sink, bitmap, drawImage, controller, frame, decodes } = await paintFixture();

    controller.send({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    await frame('low-latency-frame');
    expect(platform.agentBrowserScreenshot).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(sink.canvas.width).toBe(40);
    expect(sink.canvas.height).toBe(30);
    expect(controller.snapshot().hasFrame).toBe(true);

    // Once pointer activity is old, an animated page must not keep decoding its
    // CSS-resolution stream at frame rate; the throttled crisp path remains.
    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    await frame('idle-animation-frame');
    expect(decodes()).toBe(1);
  });

  it('paints the stream frame after keys, pasted text and editing chords, not only after pointer input', async () => {
    const { clock, platform, controller, frame, decodes } = await paintFixture(undefined, {
      agentBrowserEdit: vi.fn(async () => ({ ok: true })),
      readClipboardText: vi.fn(async () => 'pasted'),
    });
    await frame('first');
    expect(decodes()).toBe(1);

    // At rest, a changed frame only pulses the crisp loop.
    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    await frame('idle');
    expect(decodes()).toBe(1);

    controller.handleKeyDownLike({ key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    await frame('typed');
    expect(decodes()).toBe(2);

    // A paste is replayed as key input once the clipboard read resolves.
    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    controller.handleKeyDownLike({ key: 'v', code: 'KeyV', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    await flushMicrotasks();
    expect(platform.readClipboardText).toHaveBeenCalled();
    await frame('pasted');
    expect(decodes()).toBe(3);

    // A select-all runs through the host rather than the stream.
    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    controller.handleKeyDownLike({ key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
    expect(platform.agentBrowserEdit).toHaveBeenCalledWith('sess', 'selectAll', undefined);
    await frame('selected');
    expect(decodes()).toBe(4);
  });

  it('paints the stream while a crisp capture waits behind a blocking command, then draws that capture', async () => {
    const releases: Array<(shot: Shot) => void> = [];
    const { clock, platform, drawImage, frame, decodes } = await paintFixture(() => new Promise((resolve) => { releases.push(resolve); }));
    // The first image paints from the stream, superseding the capture it pulsed;
    // its replacement is the one a page-loading `open` then holds.
    await frame('previous page');
    clock.now += 300;
    releases[0]({ ok: true, bytes: new Uint8Array([1]), mime: 'image/jpeg' });
    await flushMicrotasks();
    expect(platform.agentBrowserScreenshot).toHaveBeenCalledTimes(2);
    const decoded = decodes();

    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    await frame('loading');
    expect(decodes()).toBe(decoded);
    // Overdue now: the loading page paints from the stream.
    clock.now += 400;
    await frame('still loading');
    expect(decodes()).toBe(decoded + 1);

    // `open` returns: the held capture is drawn on arrival rather than dropped
    // as older than the overdue paints (the follow-up its wait's pulses owe
    // comes after).
    const drawn = drawImage.mock.calls.length;
    clock.now += 1000;
    releases[1]({ ok: true, bytes: new Uint8Array([2]), mime: 'image/jpeg' });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(drawImage.mock.calls.length).toBe(drawn + 1);
  });

  it('repaints a byte-identical crisp capture over a provisional paint', async () => {
    // A provisional paint changes the canvas behind the loop's byte-dedup, so a
    // resting page's byte-identical capture must still repaint over the blur.
    const { clock, platform, drawImage, controller, frame } = await paintFixture(
      async () => ({ ok: true, bytes: new Uint8Array([9, 9, 9]), mime: 'image/jpeg' }),
    );
    await frame('first');
    expect(controller.snapshot().hasFrame).toBe(true);

    // Past the input window a frame is a bare pulse, so this capture lands as
    // the crisp resting frame the loop records.
    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    await frame('rest');
    const afterCrisp = drawImage.mock.calls.length;
    expect(platform.agentBrowserScreenshot).toHaveBeenCalled();

    controller.send({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    await frame('hover');
    const afterProvisional = drawImage.mock.calls.length;
    expect(afterProvisional).toBeGreaterThan(afterCrisp);

    clock.now += PROVISIONAL_INPUT_WINDOW_MS + 1;
    await frame('settled');
    expect(drawImage.mock.calls.length).toBeGreaterThan(afterProvisional);
  });
});

describe('sync-to-pane', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('issues one viewport once a pane resize settles, and re-syncs a display-scale change at once', async () => {
    const command = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    platform.agentBrowserCommand = command;
    setPlatform(platform);
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
    const viewports = () => command.mock.calls
      .map((call) => (call as unknown as [string, string[]])[1])
      .filter((args) => args[0] === 'set' && args[1] === 'viewport');

    const controller = withPort('id', { session: 'sess' }, 4321);
    controller.attachView(sink);
    await flushMicrotasks();
    // Sync is engaged by default, so attaching sized the browser to the pane.
    expect(viewports().at(-1)).toEqual(['set', 'viewport', '800', '600', '1']);
    const issued = viewports().length;

    // A window drag resizes the pane every frame; one viewport lands after it settles.
    for (let w = 801; w <= 860; w++) {
      resizePane(w, 600);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(viewports()).toHaveLength(issued);
    await vi.advanceTimersByTimeAsync(200);
    expect(viewports().slice(issued)).toEqual([['set', 'viewport', '860', '600', '1']]);

    dpr = 2;
    queries.at(-1)!.onChange!();
    expect(viewports().at(-1)).toEqual(['set', 'viewport', '860', '600', '2']);
    // Re-armed for the new scale.
    expect(queries.at(-1)!.media).toBe('(resolution: 2dppx)');
    expect(queries.at(-1)!.onChange).toBeDefined();
  });
});

describe('sync-to-pane while parked', () => {
  it('pushes a resize made behind a hidden pane once it is live again', async () => {
    vi.useFakeTimers();
    try {
      const command = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserAttach'>;
      platform.agentBrowserCommand = command;
      platform.agentBrowserAttach = vi.fn(async () => ({ ok: true, wsPort: 4321 }));
      setPlatform(platform);
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { observers.push(callback); }
        observe() {}
        disconnect() {}
      });
      const sink = makeSink();
      let size = { width: 800, height: 600 };
      sink.viewport.getBoundingClientRect = () => ({ ...size }) as DOMRect;
      const viewports = () => command.mock.calls
        .map((call) => (call as unknown as [string, string[]])[1])
        .filter((args) => args[1] === 'viewport');

      const controller = withPort('id', { session: 'sess' }, 4321);
      controller.attachView(sink);
      await vi.advanceTimersByTimeAsync(0);
      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);

      size = { width: 1000, height: 700 };
      observers.at(-1)?.([{ contentRect: { width: 1000, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
      await vi.advanceTimersByTimeAsync(250);
      expect(viewports().at(-1)).toEqual(['set', 'viewport', '800', '600', '1']);

      // Unparked at the same port: the size it missed still goes out.
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(viewports().at(-1)).toEqual(['set', 'viewport', '1000', '700', '1']);
    } finally {
      vi.useRealTimers();
    }
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

    const controller = withPort('id', { session: 'sess' }, 4321);
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

      const controller = withPort('id', { session: 'sess' }, 4321);
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

});

describe('launch', () => {
  type Open = PlatformAdapter['agentBrowserOpen'];
  function launchPlatform(open: NonNullable<Open>) {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'agentBrowserCommand' | 'agentBrowserAttach'>;
    platform.agentBrowserOpen = vi.fn(open);
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserAttach = vi.fn(async () => ({ ok: true, wsPort: 9999 }));
    setPlatform(platform);
    return platform;
  }

  it('a session-less pane opens its page, binds the session the host answers with, and streams', async () => {
    const platform = launchPlatform(async () => ({ ok: true, session: 'dormouse.1.gui-abc', wsPort: 4321, binaryPath: '/usr/bin/agent-browser' }));
    const launched = whenBrowserLaunched('id');
    // A restored pane whose launch never landed is the same pane.
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-screencast', url: 'https://page.example/', binaryPath: '/usr/bin/agent-browser',
    });
    const sink = makeSink();
    controller.attachView(sink);
    expect(controller.snapshot().phase).toBe('launching');
    await flushMicrotasks();

    expect(platform.agentBrowserOpen).toHaveBeenCalledExactlyOnceWith('https://page.example/', { headed: false }, '/usr/bin/agent-browser');
    expect(sink.updateParameters).toHaveBeenCalledWith({ session: 'dormouse.1.gui-abc', binaryPath: '/usr/bin/agent-browser' });
    expect(streamSocket(4321)?.readyState).toBe(1);
    expect(platform.agentBrowserAttach).not.toHaveBeenCalled();
    expect(await launched).toBeNull();
    // Driven as the session it bound.
    getAgentBrowserScreenController('id')!.chromeActions.reload();
    expect(platform.agentBrowserCommand).toHaveBeenLastCalledWith('dormouse.1.gui-abc', ['reload'], '/usr/bin/agent-browser');

    // Params that predate that write — a remounted view feeding them before its
    // flush — do not take the session away and launch again.
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/', session: 'dormouse.1.gui-abc' });
    await flushMicrotasks();
    expect(platform.agentBrowserOpen).toHaveBeenCalledTimes(1);
    expect(streamSockets(4321)).toHaveLength(1);
  });

  it('opens in the session params name, headed for a pop-out, and binds it', async () => {
    const platform = launchPlatform(async () => ({ ok: true, session: 'dormouse.1.tool.t', wsPort: 4321 }));
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-popout', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t',
    });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    expect(platform.agentBrowserOpen).toHaveBeenCalledWith('http://localhost:6006/', { headed: true, session: 'dormouse.1.tool.t' }, undefined);
    expect(sink.updateParameters).toHaveBeenCalledWith({ session: 'dormouse.1.tool.t', launchSession: undefined, launchFallback: undefined });
  });

  it('a failed launch says why, in the pane and to whoever awaited it', async () => {
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.playwright = vi.fn(async () => ({ ok: false }));
    setPlatform(platform);
    const launched = whenBrowserLaunched('pw');
    const controller = acquireAgentBrowserSurfaceController('pw', { renderMode: 'pw-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(await launched).toBe('Could not open Playwright');
    expect(controller.snapshot()).toMatchObject({ phase: 'ended', error: 'Could not open Playwright' });
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  it('a Surface closed mid-launch closes the browser that comes up, and its waiter hears it is gone', async () => {
    let answer!: (res: { ok: boolean; session?: string; wsPort?: number }) => void;
    const platform = launchPlatform(() => new Promise((resolve) => { answer = resolve; }));
    const launched = whenBrowserLaunched('id');
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();

    closeBrowserSurface('id', { surfaceType: 'browser', renderMode: 'ab-screencast', url: 'https://page.example/' });
    expect(await launched).toBeNull();
    expect(platform.agentBrowserCommand).not.toHaveBeenCalled();

    answer({ ok: true, session: 'dormouse.1.gui-late', wsPort: 4321 });
    await flushMicrotasks();
    expect(platform.agentBrowserCommand).toHaveBeenCalledExactlyOnceWith('dormouse.1.gui-late', ['close'], undefined);
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  it('a navigation out of a failed launch launches at its page, and loads it once', async () => {
    const answers = [{ ok: false, error: 'boom' }, { ok: true, session: 'dormouse.1.gui-n', wsPort: 4321 }];
    const platform = launchPlatform(async () => answers.shift()!);
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    await flushMicrotasks();
    expect(platform.agentBrowserOpen).toHaveBeenLastCalledWith('https://next.example/', { headed: false }, undefined);
    expect(streamSocket(4321)?.readyState).toBe(1);
    expect(opens(platform)).toEqual([]);
  });

  it('ignores params that predate the session its launch bound', async () => {
    const platform = launchPlatform(async () => ({ ok: true, session: 'dormouse.1.gui-abc', wsPort: 4321 }));
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();

    // A remounted view feeds the params it rendered with, before the write shows.
    controller.updateParams({ renderMode: 'ab-screencast', url: 'https://page.example/' });
    await flushMicrotasks();
    expect(platform.agentBrowserOpen).toHaveBeenCalledOnce();
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('never closes the session a launch opened when the Surface has since bound it', async () => {
    let answer!: (res: { ok: boolean; session?: string; wsPort?: number }) => void;
    const platform = launchPlatform(() => new Promise((resolve) => { answer = resolve; }));
    const controller = acquireAgentBrowserSurfaceController('id', {
      renderMode: 'ab-screencast', url: 'http://localhost:6006/', launchSession: 'dormouse.1.tool.t',
    });
    controller.attachView(makeSink());
    await flushMicrotasks();

    controller.updateParams({ renderMode: 'ab-screencast', url: 'http://localhost:6006/', session: 'dormouse.1.tool.t' });
    controller.handOver(4321);
    answer({ ok: true, session: 'dormouse.1.tool.t', wsPort: 4321 });
    await flushMicrotasks();
    expect(platform.agentBrowserCommand).not.toHaveBeenCalledWith('dormouse.1.tool.t', ['close'], undefined);
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('launches with the binary `dor ab` last resolved, and remembers the one it ran', async () => {
    const platform = launchPlatform(async () => ({ ok: true, session: 'dormouse.1.gui-b', wsPort: 4321, binaryPath: '/opt/ab/agent-browser' }));
    rememberLaunchBinaryPath('agent-browser', '/usr/local/bin/agent-browser');
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();
    expect(platform.agentBrowserOpen).toHaveBeenCalledWith('https://page.example/', { headed: false }, '/usr/local/bin/agent-browser');
    expect(launchBinaryPath('agent-browser')).toBe('/opt/ab/agent-browser');
  });

  it('tells the Wall about a failed launch, once a view is attached to hear it', async () => {
    launchPlatform(async () => ({ ok: false, error: 'boom' }));
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
    const answers: Array<(res: { ok: boolean; session?: string; wsPort?: number }) => void> = [];
    const platform = launchPlatform(() => new Promise((resolve) => { answers.push(resolve); }));
    const named = acquireAgentBrowserSurfaceController('named', { renderMode: 'ab-screencast', url: 'https://page.example/', launchSession: 'dormouse.1.tool.t' });
    named.attachView(makeSink());
    const minted = acquireAgentBrowserSurfaceController('minted', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    minted.attachView(makeSink());
    await flushMicrotasks();

    // A Workspace transfer: the destination opens the same named session.
    disposeAgentBrowserSurfaceController('named');
    disposeAgentBrowserSurfaceController('minted');
    answers[0]({ ok: true, session: 'dormouse.1.tool.t', wsPort: 4321 });
    answers[1]({ ok: true, session: 'dormouse.1.gui-x', wsPort: 4322 });
    await flushMicrotasks();
    expect(platform.agentBrowserCommand).toHaveBeenCalledExactlyOnceWith('dormouse.1.gui-x', ['close'], undefined);
  });

  it('a controller released before it ever started still settles its waiter', async () => {
    launchPlatform(async () => ({ ok: true }));
    const launched = whenBrowserLaunched('id');
    acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-screencast', url: 'https://page.example/' });
    disposeAgentBrowserSurfaceController('id');
    expect(await launched).toBeNull();
  });

  it('a Surface killed before its view ever mounted still settles its waiter', async () => {
    launchPlatform(async () => ({ ok: true }));
    const launched = whenBrowserLaunched('never-mounted');
    closeBrowserSurface('never-mounted', { surfaceType: 'browser', renderMode: 'ab-screencast', url: 'https://page.example/' });
    expect(await launched).toBeNull();
  });
});

describe('attach', () => {
  function attachPlatform(attach: PlatformAdapter['agentBrowserAttach']) {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserAttach' | 'agentBrowserCommand'>;
    platform.agentBrowserAttach = vi.fn(attach);
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setPlatform(platform);
    return platform;
  }

  it('a restored pane attaches at the page and presentation it had', async () => {
    const platform = attachPlatform(async () => ({ ok: true, wsPort: 2222 }));
    const controller = acquireAgentBrowserSurfaceController('id', {
      session: 'sess', renderMode: 'ab-popout', url: 'https://restored.example/',
    });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    expect(platform.agentBrowserAttach).toHaveBeenCalledExactlyOnceWith('sess', { url: 'https://restored.example/', headed: true }, undefined);
    expect(streamSocket(2222)?.readyState).toBe(1);
  });

  it('streams from a port `dor` hands over, out of `ended` too', async () => {
    attachPlatform(async () => ({ ok: false, error: 'not running' }));
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('ended');

    handOverBrowserPort('id', { session: 'sess', url: 'https://page.example/' }, 4321);
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSocket(4321)?.readyState).toBe(1);
  });

  it('a browser that cannot be reopened says why', async () => {
    attachPlatform(async () => ({ ok: false, error: 'agent-browser binary not found' }));
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://restored.example/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(controller.snapshot()).toMatchObject({ phase: 'ended', error: 'agent-browser binary not found' });
    expect(WebSocketMock.instances).toHaveLength(0);
  });

  /** A live pane on 1111, parked. */
  async function parkedAt1111(attach: PlatformAdapter['agentBrowserAttach']) {
    const platform = attachPlatform(attach);
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    controller.attachView(makeSink());
    await vi.advanceTimersByTimeAsync(0);
    expect(streamSocket(1111)?.readyState).toBe(1);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
    expect(controller.isParked()).toBe(true);
    expect(streamSocket(1111)?.readyState).toBe(3);
    return { platform, controller };
  }

  it('never attaches while parked, and an unpark whose port still answers asks the host nothing', async () => {
    vi.useFakeTimers();
    try {
      const { platform, controller } = await parkedAt1111(async () => ({ ok: true, wsPort: 2222 }));
      // Hidden and shown again, a headless pane never left `live` for its view.
      expect(controller.snapshot().phase).toBe('live');
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(streamSockets(1111)).toHaveLength(2);
      expect(streamSocket(1111)?.readyState).toBe(1);
      expect(platform.agentBrowserAttach).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unpark whose port fails asks the host, without a page, where the stream moved', async () => {
    vi.useFakeTimers();
    try {
      const { platform, controller } = await parkedAt1111(async () => ({ ok: true, wsPort: 2222 }));
      WebSocketMock.failPorts.add(1111);
      controller.setVisible(true);
      await vi.advanceTimersByTimeAsync(0);
      // Without a page: a daemon gone while hidden has ended, it is not
      // relaunched behind the user's back.
      expect(platform.agentBrowserAttach).toHaveBeenCalledExactlyOnceWith('sess', { url: undefined, headed: false }, undefined);
      expect(streamSocket(2222)?.readyState).toBe(1);
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
    const platform = attachPlatform(async () => ({ ok: true, wsPort: 3333 }));
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
    expect(platform.agentBrowserAttach).not.toHaveBeenCalled();

    // `dor ab open` brings it back on the port it had.
    handOverBrowserPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSockets(1111)).toHaveLength(2);

    // Ended again, a URL-bar navigation attaches — never a daemon command, which
    // would start a daemon on a port nobody learns. Its daemon was still up, so
    // attach only found it: the page opens once live.
    streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: true }));
    streamSocket(1111)!.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    expect(platform.agentBrowserCommand).not.toHaveBeenCalledWith('sess', ['open', 'https://next.example/'], undefined);
    expect(platform.agentBrowserAttach).toHaveBeenCalledExactlyOnceWith('sess', { url: 'https://next.example/', headed: false }, undefined);
    await flushMicrotasks();
    expect(streamSocket(3333)?.readyState).toBe(1);
    expect(opens(platform)).toEqual(['https://next.example/']);
  });

  it('a navigation that relaunches a gone daemon loads its page once', async () => {
    const platform = attachPlatform(async () => ({ ok: false, error: 'not running' }));
    acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' }).attachView(makeSink());
    await flushMicrotasks();
    vi.mocked(platform.agentBrowserAttach!).mockResolvedValue({ ok: true, wsPort: 3333, relaunched: true });

    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
    await flushMicrotasks();
    expect(platform.agentBrowserAttach).toHaveBeenLastCalledWith('sess', { url: 'https://next.example/', headed: false }, undefined);
    expect(streamSocket(3333)?.readyState).toBe(1);
    expect(opens(platform)).toEqual([]);
  });

  it('does not query the daemon while a relaunch is in flight', async () => {
    const platform = attachPlatform(async () => ({ ok: true, wsPort: 9999 }));
    const popOut = vi.fn(() => new Promise<never>(() => {}));
    Object.assign(platform, { agentBrowserPopOut: popOut });

    const controller = withPort('id', { session: 'sess' }, 1111);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    vi.mocked(platform.agentBrowserCommand!).mockClear();

    // A stream drop mid-relaunch must not spawn a competing daemon.
    streamSocket(1111)?.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
    await flushMicrotasks();
    expect(platform.agentBrowserAttach).not.toHaveBeenCalled();
    expect(platform.agentBrowserCommand).not.toHaveBeenCalled();
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
  function closePlatform() {
    let resolvePopOut!: (res: { ok: boolean; wsPort?: number }) => void;
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopOut'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserPopOut = vi.fn(() => new Promise((r) => { resolvePopOut = r; }));
    setPlatform(platform);
    const closes = () => vi.mocked(platform.agentBrowserCommand!).mock.calls.filter(([, args]) => args[0] === 'close');
    return { platform, closes, resolvePopOut: (res: { ok: boolean; wsPort?: number }) => resolvePopOut(res) };
  }

  it('closes the session again when a relaunch in flight brings its daemon back', async () => {
    const { closes, resolvePopOut } = closePlatform();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');

    closeBrowserSurface('id', { renderMode: 'ab-popout', session: 'sess' });
    expect(closes()).toHaveLength(1);
    expect(getAgentBrowserSurfaceController('id')).toBeNull();

    resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(closes()).toHaveLength(2);
    expect(streamSockets(3456)).toHaveLength(0);
  });

  it('a release that closes nothing leaves a relaunch in flight to whoever holds the session next', async () => {
    const { closes, resolvePopOut } = closePlatform();
    const controller = withPort('id', { session: 'sess' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');

    disposeAgentBrowserSurfaceController('id');
    resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(closes()).toHaveLength(0);
  });

  it('closes a session no controller holds from its params, with only a checked binary', async () => {
    const { platform } = closePlatform();
    closeBrowserSurface('never-mounted', { surfaceType: 'browser', renderMode: 'ab-screencast', session: 'sess', binaryPath: '/usr/bin/curl' });
    closeBrowserSurface('iframe', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/' });
    expect(platform.agentBrowserCommand).toHaveBeenCalledExactlyOnceWith('sess', ['close'], undefined);
  });
});

describe('relaunch (pop-out / pop-in)', () => {
  type RelaunchPlatform = FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopOut' | 'agentBrowserPopIn' | 'agentBrowserAttach'>;
  function relaunchPlatform(): RelaunchPlatform & { resolvePopOut: (res: { ok: boolean; wsPort?: number }) => void } {
    const platform = new FakePtyAdapter() as RelaunchPlatform;
    let resolvePopOut!: (res: { ok: boolean; wsPort?: number }) => void;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserAttach = vi.fn(async () => ({ ok: true, wsPort: 9999 }));
    platform.agentBrowserPopOut = vi.fn(() => new Promise<{ ok: boolean; wsPort?: number }>((r) => { resolvePopOut = r; }));
    platform.agentBrowserPopIn = vi.fn(async () => ({ ok: true, wsPort: 5555 }));
    setPlatform(platform);
    return Object.assign(platform, { resolvePopOut: (res: { ok: boolean; wsPort?: number }) => resolvePopOut(res) });
  }

  it('drops the stream up front and connects to the host\'s port only once the relaunch ends', async () => {
    const platform = relaunchPlatform();
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
    // No daemon command while the relaunch is in flight: not even the popped-out
    // CDP observer's `get cdp-url`.
    expect(platform.agentBrowserCommand).not.toHaveBeenCalledWith('sess', ['get', 'cdp-url'], undefined);

    platform.resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe('live');
    expect(streamSockets(3456).length).toBe(1);
    expect(streamSockets(1111).length).toBe(1);
    expect(platform.agentBrowserCommand).toHaveBeenCalledWith('sess', ['get', 'cdp-url'], undefined);
    expect(platform.agentBrowserAttach).not.toHaveBeenCalled();
  });

  it('ignores a second pop-out or pop-in while one is in flight', async () => {
    const platform = relaunchPlatform();
    const controller = withPort('id', { session: 'sess' }, 1111);
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

  it('pop-in while the first launch is in flight is a no-op', async () => {
    const platform = relaunchPlatform();
    Object.assign(platform, { agentBrowserOpen: vi.fn(() => new Promise<never>(() => {})) });
    const controller = acquireAgentBrowserSurfaceController('id', { renderMode: 'ab-popout', url: 'https://page.example/' });
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    controller.popIn();
    expect(platform.agentBrowserPopIn).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ poppedOut: true, phase: 'launching' });
    expect(sink.updateParameters).not.toHaveBeenCalledWith({ renderMode: 'ab-screencast' });
  });

  it('a relaunch carries the URL the stream committed, not the one the last tabs snapshot reported', async () => {
    const platform = relaunchPlatform();
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
    expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: 'https://slow.example/' }), undefined);
  });

  it('relaunches at the last page the host can reopen, not a file: or data: tab', async () => {
    const platform = relaunchPlatform();
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
    expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: 'https://app.example/report' }), undefined);
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
    const platform = relaunchPlatform();
    const edit = vi.fn(async () => ({ ok: true }));
    Object.assign(platform, { agentBrowserEdit: edit });
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
      vi.mocked(platform.agentBrowserCommand!).mockClear();

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
      expect(platform.agentBrowserCommand).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();

      // The relaunch lands: only the latest navigation runs, once.
      platform.resolvePopOut({ ok: true, wsPort: 3456 });
      await vi.advanceTimersByTimeAsync(0);
      const opens = vi.mocked(platform.agentBrowserCommand!).mock.calls.filter(([, args]) => args[0] === 'open');
      expect(opens).toEqual([['sess', ['open', 'https://latest.example/'], undefined]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sync-to-pane out of a pop-in gap, and re-syncs once the headless browser streams', async () => {
    const platform = relaunchPlatform();
    let resolvePopIn!: (res: { ok: boolean; wsPort?: number }) => void;
    platform.agentBrowserPopIn = vi.fn(() => new Promise((r) => { resolvePopIn = r; }));
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
    const viewports = () => vi.mocked(platform.agentBrowserCommand!).mock.calls.filter(([, args]) => args[1] === 'viewport');
    expect(viewports()).toEqual([]);

    resolvePopIn({ ok: true, wsPort: 5555 });
    await flushMicrotasks();
    expect(viewports()).toEqual([['sess', ['set', 'viewport', '800', '600', '1'], undefined]]);
  });

  it('a pop-out asked for with a page relaunches there instead of navigating into the gap', async () => {
    const platform = relaunchPlatform();
    const controller = withPort('id', { session: 'sess', url: 'https://before.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    vi.mocked(platform.agentBrowserCommand!).mockClear();

    // The pane context menu's reuse of an existing port target.
    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout', { url: 'http://localhost:5173/' });
    expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: 'http://localhost:5173/' }), undefined);
    platform.resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(platform.agentBrowserCommand).not.toHaveBeenCalledWith('sess', ['open', 'http://localhost:5173/'], undefined);
  });

  it('a navigation to the page a relaunch is opening loads it once', async () => {
    const platform = relaunchPlatform();
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    getAgentBrowserScreenController('id')!.chromeActions.navigate('https://page.example/');
    platform.resolvePopOut({ ok: true, wsPort: 3456 });
    await flushMicrotasks();
    expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: 'https://page.example/' }), undefined);
    expect(opens(platform)).toEqual([]);
  });

  it.each([
    ['the page asked for while it was parked', undefined, 'https://next.example/'],
    ['the page it asks for, over one asked for earlier', 'http://localhost:5173/', 'http://localhost:5173/'],
  ])('a pop-out from a parked pane opens %s, once', async (_name, asked, opened) => {
    vi.useFakeTimers();
    try {
      const platform = relaunchPlatform();
      const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
      controller.attachView(makeSink());
      await vi.advanceTimersByTimeAsync(0);
      controller.setVisible(false);
      await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50);
      expect(controller.isParked()).toBe(true);

      getAgentBrowserScreenController('id')!.chromeActions.navigate('https://next.example/');
      getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout', asked ? { url: asked } : undefined);
      expect(platform.agentBrowserPopOut).toHaveBeenCalledWith('sess', expect.objectContaining({ url: opened }), undefined);
      platform.resolvePopOut({ ok: true, wsPort: 3456 });
      await vi.advanceTimersByTimeAsync(0);
      expect(opens(platform)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pop-out asked for before the browser is bound, and runs it with its page once live', async () => {
    const platform = relaunchPlatform();
    let attached!: (res: { ok: boolean; wsPort?: number }) => void;
    platform.agentBrowserAttach = vi.fn(() => new Promise((resolve) => { attached = resolve; }));
    const controller = acquireAgentBrowserSurfaceController('id', { session: 'sess', url: 'https://page.example/' });
    // Before any view mounts it, as for a Door the context menu reveals.
    controller.setRenderMode('ab-popout', { url: 'http://localhost:5173/' });
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(platform.agentBrowserAttach).toHaveBeenCalled();
    expect(platform.agentBrowserPopOut).not.toHaveBeenCalled();

    attached({ ok: true, wsPort: 1111 });
    await flushMicrotasks();
    expect(platform.agentBrowserPopOut).toHaveBeenCalledExactlyOnceWith('sess', expect.objectContaining({ url: 'http://localhost:5173/' }), undefined);
  });

  it('a failed pop-out comes back in the pane, relaunching headless at its page if no daemon came up', async () => {
    const platform = relaunchPlatform();
    const controller = withPort('id', { session: 'sess', url: 'https://page.example/' }, 1111);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();

    getAgentBrowserScreenController('id')?.actions.setRenderMode?.('ab-popout');
    platform.resolvePopOut({ ok: false });
    await flushMicrotasks();
    expect(platform.agentBrowserAttach).toHaveBeenCalledExactlyOnceWith('sess', { url: 'https://page.example/', headed: false }, undefined);
    expect(sink.updateParameters).toHaveBeenLastCalledWith({ renderMode: 'ab-screencast' });
    expect(controller.snapshot()).toMatchObject({ poppedOut: false, phase: 'live' });
    expect(streamSocket(9999)?.readyState).toBe(1);
  });

  it('a `dor ab` re-run handing over a new port reconnects there and asks the daemon nothing', async () => {
    const platform = relaunchPlatform();
    const controller = withPort('id', { session: 'sess', url: 'https://x.example/' }, 1111);
    controller.attachView(makeSink());
    await flushMicrotasks();
    expect(streamSocket(1111)?.readyState).toBe(1);

    controller.handOver(4321);
    await flushMicrotasks();
    expect(streamSocket(1111)?.readyState).toBe(3);
    expect(streamSockets(4321)).toHaveLength(1);
    expect(platform.agentBrowserAttach).not.toHaveBeenCalled();
  });
});

describe('Playwright provider', () => {
  it('pastes as whole-text messages the host inserts, not a key pair per character', async () => {
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.playwright = vi.fn(async request => request.op === 'streamUrl'
      ? { ok: true, url: `ws://127.0.0.1:${request.port}` }
      : { ok: true, exitCode: 0, stdout: '', stderr: '' });
    const pasted = `${'x'.repeat(PLAYWRIGHT_TEXT_INPUT_MAX + 10)}\r\nend`;
    platform.readClipboardText = vi.fn(async () => pasted);
    setPlatform(platform);
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
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.playwright = vi.fn(async request => request.op === 'command'
      ? { ok: false, error: 'boom', exitCode: 1, stdout: '', stderr: 'boom' }
      : { ok: true });
    setPlatform(platform);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = withPort('pw', { renderMode: 'pw-screencast', session: 's' }, 4321);
    controller.attachView(makeSink());
    getAgentBrowserScreenController('pw')!.chromeActions.reload();
    await flushMicrotasks();
    expect(warn).toHaveBeenCalledWith('[playwright] reload failed:', 'boom');
  });

  it('uses the shared controller with provider-scoped host calls and cwd', async () => {
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    // The swap back to agent-browser is offered only where the host can launch one.
    platform.agentBrowserOpen = vi.fn(async () => ({ ok: true }));
    platform.playwright = vi.fn(async request => request.op === 'streamUrl'
      ? { ok: true, url: `ws://127.0.0.1:${request.port}` }
      : { ok: true, exitCode: 0, stdout: '', stderr: '', wsPort: 4321 });
    setPlatform(platform);
    const controller = withPort('pw', { renderMode: 'pw-screencast', session: 'shared-name', cwd: '/first-project' }, 4321);
    const sink = makeSink();
    controller.attachView(sink);
    await flushMicrotasks();
    getAgentBrowserScreenController('pw')!.chromeActions.navigate('https://example.com/next');
    await flushMicrotasks();
    expect(platform.playwright).toHaveBeenCalledWith(expect.objectContaining({ op: 'command', session: 'shared-name', cwd: '/first-project', args: ['open', 'https://example.com/next'] }));
    expect(platform.agentBrowserCommand).not.toHaveBeenCalled();
    expect(getAgentBrowserScreenController('pw')!.snapshot().renderMode).toBe('pw-screencast');
    getAgentBrowserScreenController('pw')!.actions.setRenderMode?.('ab-screencast');
    expect(sink.requestRenderSwap).toHaveBeenCalledWith('ab-screencast');
    controller.updateParams({ renderMode: 'pw-popout', session: 'shared-name', cwd: '/first-project' });
    expect(getAgentBrowserScreenController('pw')!.snapshot().renderMode).toBe('pw-popout');
  });
});
