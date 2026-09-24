// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserHost } from './browser-host';
import { fakeProvider, openViewer, syncStates } from './browser-host-test-utils';
import { SYNC_SETTLE_MS } from './browser-sync';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

describe('createBrowserHost', () => {
  it('finishes a close of a session before a launch into it begins', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const session = { session: 'dormouse.1.default' };
    fake.gate('close dormouse.1.default');
    const closing = host.request({ provider: 'agent-browser', binding: session, op: 'close' });
    // A failed swap reopening the browser it had just closed.
    const launching = host.request({ provider: 'agent-browser', binding: session, op: 'launch', url: 'http://localhost:5173/', headed: false });
    await flush();
    expect(fake.calls).toEqual(['close dormouse.1.default']);
    fake.release('close dormouse.1.default');
    expect(await closing).toEqual({ ok: true });
    expect(await launching).toMatchObject({ ok: true, session: 'dormouse.1.default', stream: 4321 });
    expect(fake.calls).toEqual(['close dormouse.1.default', 'stop dormouse.1.default', 'open dormouse.1.default http://localhost:5173/']);
  });

  it('closes a browser after the launch of it still running, superseding one sent before the close that has not begun', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const tool = { provider: 'agent-browser', binding: { session: 'dormouse.1.tool.t' } } as const;
    const launch = { ...tool, op: 'launch', url: 'http://localhost:6006/', headed: false } as const;
    fake.gate('stop dormouse.1.tool.t');
    // A Tool's browser still coming up when its Surface closes; the next
    // Surface to launch the name is closed too before its turn comes, and a
    // third launches it after both closes.
    const first = host.request(launch);
    await flush();
    const closes = [host.request({ ...tool, op: 'close' })];
    const superseded = host.request(launch);
    closes.push(host.request({ ...tool, op: 'close' }));
    const third = host.request(launch);
    fake.release('stop dormouse.1.tool.t');
    expect(await first).toMatchObject({ ok: true, stream: 4321 });
    expect(await superseded).toEqual({ ok: false, error: 'the browser was closed' });
    expect(await Promise.all(closes)).toEqual([{ ok: true }, { ok: true }]);
    expect(await third).toMatchObject({ ok: true, stream: 4321 });
    expect(fake.calls).toEqual([
      'stop dormouse.1.tool.t', 'open dormouse.1.tool.t http://localhost:6006/',
      'close dormouse.1.tool.t', 'close dormouse.1.tool.t',
      'stop dormouse.1.tool.t', 'open dormouse.1.tool.t http://localhost:6006/',
    ]);
  });

  it('opens nothing for a request a close cancelled before it arrived, for as long and as many as it keeps', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    const launch = (requestId: string) => host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: false, requestId });
    // The Surface's launch was sent first; the transport delivered its close first.
    expect(await host.request({ ...s1, op: 'close', cancels: ['launch-1'] })).toEqual({ ok: true });
    expect(await launch('launch-1')).toEqual({ ok: false, error: 'the browser was closed' });
    expect(await host.request({ ...s1, op: 'attach', url: 'http://localhost:5173/', requestId: 'launch-1' })).toMatchObject({ ok: true });
    expect(fake.calls).toEqual(['close s1', 'open s1 http://localhost:5173/']);

    // Forgotten after five minutes, and past the newest 256.
    const now = Date.now();
    await host.request({ ...s1, op: 'close', cancels: ['stale'] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    try {
      expect(await launch('stale')).toMatchObject({ ok: true });
    } finally {
      clock.mockRestore();
    }
    for (let batch = 0; batch < 9; batch++) {
      await host.request({ ...s1, op: 'close', cancels: Array.from({ length: 32 }, (_, i) => `r${batch * 32 + i}`) });
    }
    expect(await launch('r0')).toMatchObject({ ok: true });
    expect(await launch('r287')).toEqual({ ok: false, error: 'the browser was closed' });
  });

  it('drives no browser a launch is replacing or a close is ending until it is done', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    const drive = () => Promise.all([
      host.request({ ...s1, op: 'navigate', url: 'http://localhost:5173/next' }),
      host.request({ ...s1, op: 'viewport', width: 800, height: 600, dpr: 2 }),
      host.request({ ...s1, op: 'edit', edit: 'selectAll' }),
      host.request({ ...s1, op: 'view', stream: 4321 }),
    ]);
    const refused = { ok: false, error: 'the browser is being relaunched or closed' };
    for (const [step, op] of [['stop s1', { op: 'launch', url: 'http://localhost:5173/', headed: true }], ['close s1', { op: 'close' }]] as const) {
      fake.gate(step);
      const settling = host.request({ ...s1, ...op });
      await flush();
      expect(await drive()).toEqual([refused, refused, refused, refused]);
      fake.release(step);
      expect((await settling).ok).toBe(true);
    }
    // A pop-out's relaunch holds the browser from its stop until it is up.
    expect(fake.calls).not.toContain('navigate s1');
    expect((await drive()).map((result) => result.ok)).toEqual([true, true, true, true]);
    expect(fake.calls).toContain('navigate s1');
    await host.close();
  });

  it('relays a browser over one viewer socket: its state, a provisional frame, the capture that sharpens it, and input back', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    try {
      const { url } = await host.request({ ...s1, op: 'view', stream: 4321 });
      const viewer = await openViewer(url!);
      await vi.waitFor(() => expect(fake.views).toHaveLength(1));
      const [view] = fake.views;
      expect(view).toMatchObject({ session: 's1', stream: 4321, headed: false });
      view.sink.state({ type: 'url', url: 'http://localhost:5173/' });
      view.sink.frame(new Uint8Array([0xff, 0xd8, 0xaa]), { width: 800, height: 600 });
      await vi.waitFor(() => expect(viewer.frames.map((frame) => frame.kind)).toEqual(['provisional', 'crisp']));
      expect(viewer.states).toEqual([{ type: 'url', url: 'http://localhost:5173/' }]);
      expect([...viewer.frames[1].jpeg]).toEqual([0xff, 0xd8, 1]);
      viewer.send({ type: 'input_text', text: 'hi' });
      await vi.waitFor(() => expect(view.inputs).toEqual([{ type: 'input_text', text: 'hi' }]));
      // The URL was good for this one socket.
      await expect(openViewer(url!)).rejects.toThrow('403');
      viewer.socket.close();
      await vi.waitFor(() => expect(view.closed).toBe(true));
    } finally {
      await host.close();
    }
  });

  it('joins one capture for every viewer of a browser, and ends them all when a launch or close replaces it', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    const view = async () => openViewer((await host.request({ ...s1, op: 'view', stream: 4321 })).url!);
    try {
      // Two Surfaces on one session: a Workspace transfer's two ends.
      const viewers = [await view(), await view()];
      await vi.waitFor(() => expect(fake.views).toHaveLength(2));
      fake.gate('screenshot s1');
      for (const { sink } of fake.views) sink.frame(new Uint8Array([0xff, 0xd8, 0xaa]));
      await vi.waitFor(() => expect(fake.calls).toContain('screenshot s1'));
      fake.release('screenshot s1');
      await vi.waitFor(() => {
        for (const viewer of viewers) expect(viewer.frames.map((frame) => frame.kind)).toEqual(['provisional', 'crisp']);
      });
      expect(fake.calls.filter((call) => call === 'screenshot s1')).toHaveLength(1);

      // A URL granted before a relaunch opens nothing on the browser after it.
      const { url: granted } = await host.request({ ...s1, op: 'view', stream: 4321 });
      await host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: true });
      expect(await Promise.all(viewers.map((viewer) => viewer.closed))).toEqual([1001, 1001]);
      await vi.waitFor(() => expect(fake.views.map((v) => v.closed)).toEqual([true, true]));
      const late = await openViewer(granted!);
      expect(await late.closed).toBe(1001);
      expect(fake.views).toHaveLength(2);
    } finally {
      await host.close();
    }
  });

  it('paints the stream at once after an editing op, as after input', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    try {
      const viewer = await openViewer((await host.request({ ...s1, op: 'view', stream: 4321 })).url!);
      await vi.waitFor(() => expect(fake.views).toHaveLength(1));
      const { sink } = fake.views[0];
      sink.frame(new Uint8Array([0xff, 0xd8, 1]));
      await vi.waitFor(() => expect(viewer.frames.map((frame) => frame.kind)).toEqual(['provisional', 'crisp']));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // At rest, a changed frame only pulses the crisp loop.
      sink.frame(new Uint8Array([0xff, 0xd8, 2]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(viewer.frames.filter((frame) => frame.kind === 'provisional')).toHaveLength(1);
      // Select-all changed the page without any input on the socket.
      await host.request({ ...s1, op: 'edit', edit: 'selectAll' });
      sink.frame(new Uint8Array([0xff, 0xd8, 3]));
      await vi.waitFor(() => expect(viewer.frames.filter((frame) => frame.kind === 'provisional')).toHaveLength(2));
    } finally {
      await host.close();
    }
  });

  // ws refuses a close reason past 123 UTF-8 bytes by throwing; a provider's
  // error — CLI stderr, a path under a non-ASCII home — can be any length.
  it('ends a viewer whose provider cannot subscribe, whatever its error says', async () => {
    const fake = fakeProvider();
    const said = `Échec: ${'é'.repeat(200)}`;
    fake.provider.view = async () => { throw new Error(said); };
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    try {
      const viewer = await openViewer((await host.request({ provider: 'agent-browser', binding: { session: 's1' }, op: 'view', stream: 4321 })).url!);
      expect(await viewer.closed).toBe(1011);
      expect(Buffer.byteLength(viewer.reason!)).toBeLessThanOrEqual(123);
      expect(said.startsWith(viewer.reason!)).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('rejects nothing when a subscription that lands after its viewer left throws as it is dropped', async () => {
    const fake = fakeProvider();
    let land!: () => void;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    fake.provider.view = async () => {
      await landed;
      return { capturable: true, input: () => true, close: () => { throw new Error('upstream already gone'); } };
    };
    const log = vi.fn();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), log, providers: { 'agent-browser': () => fake.provider } });
    try {
      const viewer = await openViewer((await host.request({ provider: 'agent-browser', binding: { session: 's1' }, op: 'view', stream: 4321 })).url!);
      viewer.socket.close();
      await viewer.closed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      land();
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[browser-host] upstream already gone'));
    } finally {
      await host.close();
    }
  });

  it('joins no capture of the browser a relaunch replaced', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    const view = async () => openViewer((await host.request({ ...s1, op: 'view', stream: 4321 })).url!);
    try {
      await view();
      await vi.waitFor(() => expect(fake.views).toHaveLength(1));
      // The old browser's capture is still running when the relaunch lands.
      fake.gate('screenshot s1');
      fake.views[0].sink.frame(new Uint8Array([0xff, 0xd8, 0xaa]));
      await vi.waitFor(() => expect(fake.calls).toContain('screenshot s1'));
      await host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: false });
      const viewer = await view();
      await vi.waitFor(() => expect(fake.views).toHaveLength(2));
      fake.views[1].sink.frame(new Uint8Array([0xff, 0xd8, 0xbb]));
      await vi.waitFor(() => expect(fake.calls.filter((call) => call === 'screenshot s1')).toHaveLength(2));
      fake.release('screenshot s1');
      await vi.waitFor(() => expect(viewer.frames.map((frame) => frame.kind)).toEqual(['provisional', 'crisp']));
    } finally {
      await host.close();
    }
  });

  it('refuses a request id or cancel list it cannot bound', async () => {
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fakeProvider().provider } });
    const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
    for (const requestId of ['has space', 'x'.repeat(65), 7, '']) {
      expect(await host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: false, requestId })).toEqual({ ok: false, error: 'invalid request id' });
    }
    for (const cancels of ['r1', [7], ['has space'], Array.from({ length: 33 }, (_, i) => `r${i}`)]) {
      expect(await host.request({ ...s1, op: 'close', cancels })).toEqual({ ok: false, error: 'invalid cancelled request ids' });
    }
  });

  it('bounds a close, so a hung one holds its browser\'s later requests, and shutdown, only so long', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeProvider();
      // A daemon that never answers: its close ends when the bound kills the CLI.
      fake.provider.close = (_b, timeoutMs) => new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('close timed out')), timeoutMs); });
      const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
      const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
      const closing = host.request({ ...s1, op: 'close' });
      const launching = host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: false });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fake.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await closing).toEqual({ ok: false, error: 'close timed out' });
      expect(await launching).toMatchObject({ ok: true });

      // One that ignores its bound still leaves shutdown only that long.
      fake.provider.close = () => new Promise(() => {});
      void host.request({ ...s1, op: 'close' });
      let shutDown = false;
      void host.close().then(() => { shutDown = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(shutDown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps the blank tabs a launch leaves once its open returns, last first, and only beside a real page', async () => {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    fake.setTabs([{ tabId: 't1', url: 'about:blank' }, { tabId: 't2', url: 'http://localhost:5173/' }, { tabId: 't3', url: 'about:blank' }]);
    fake.gate('open s1 http://localhost:5173/');
    const launched = await Promise.race([
      host.request({ provider: 'agent-browser', binding: { session: 's1' }, op: 'launch', url: 'http://localhost:5173/', headed: false }),
      flush().then(() => null),
    ]);
    // Up before the page loads: nothing reaches the browser while `open` holds it.
    expect(launched).toMatchObject({ ok: true, stream: 4321 });
    expect(fake.calls.filter((call) => call.startsWith('tab'))).toEqual([]);
    fake.release('open s1 http://localhost:5173/');
    await flush();
    expect(fake.calls.filter((call) => call.startsWith('tab'))).toEqual(['tab s1 close t3', 'tab s1 close t1']);

    // The sole tab, or blank tabs with no real page beside them, are left.
    fake.setTabs([{ tabId: 't1', url: 'about:blank' }, { tabId: 't2', url: 'about:blank' }]);
    await host.request({ provider: 'agent-browser', binding: { session: 's2' }, op: 'launch', url: 'http://localhost:5173/', headed: false });
    await flush();
    expect(fake.calls.filter((call) => call.startsWith('tab s2'))).toEqual([]);
  });

  it('makes each provider on its first request, and shuts down closing only the browsers launched headed', async () => {
    const fake = fakeProvider();
    const playwright = vi.fn(() => fake.provider);
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { playwright } });
    expect(playwright).not.toHaveBeenCalled();
    await host.request({ provider: 'playwright', binding: { session: 'shown' }, op: 'launch', headed: true });
    await host.request({ provider: 'playwright', binding: { session: 'hidden' }, op: 'launch', headed: false });
    // A browser relaunched headless leaves shutdown's list.
    await host.request({ provider: 'playwright', binding: { session: 'back' }, op: 'launch', headed: true });
    await host.request({ provider: 'playwright', binding: { session: 'back' }, op: 'launch', headed: false });
    expect(playwright).toHaveBeenCalledOnce();
    fake.calls.length = 0;
    await host.close();
    expect(fake.calls).toEqual(['close shown']);
    // A headed launch still waiting on its browser is closed at once, so a
    // window whose page never loads is not orphaned.
    const slow = fakeProvider();
    slow.provider.probe = async () => undefined;
    slow.gate('open slow blank headed');
    const quitting = createBrowserHost({ writeClipboardText: vi.fn(), providers: { playwright: () => slow.provider } });
    const launching = quitting.request({ provider: 'playwright', binding: { session: 'slow' }, op: 'launch', headed: true });
    await flush();
    void quitting.close();
    await flush();
    expect(slow.calls).toContain('close slow');
    slow.release('open slow blank headed');
    expect((await launching).ok).toBe(false);
    // A provider no request needed is never made, not even to shut down.
    const unused = vi.fn(() => fake.provider);
    await createBrowserHost({ writeClipboardText: vi.fn(), providers: { playwright: unused } }).close();
    expect(unused).not.toHaveBeenCalled();
  });
});

describe('sync-to-pane', () => {
  const s1 = { provider: 'agent-browser', binding: { session: 's1' } } as const;
  const hosts: ReturnType<typeof createBrowserHost>[] = [];
  afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });
  const settled = () => new Promise((resolve) => setTimeout(resolve, SYNC_SETTLE_MS + 100));

  /** A pane's viewer socket on browser `s1`, streaming at 4321. */
  async function paneOn({ headed = false } = {}) {
    const fake = fakeProvider();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => fake.provider } });
    hosts.push(host);
    const viewer = await openViewer((await host.request({ ...s1, op: 'view', stream: 4321, ...(headed ? { headed } : {}) })).url!);
    await vi.waitFor(() => expect(fake.views).toHaveLength(1));
    return {
      fake,
      host,
      viewer,
      /** The provider's word on the browser's viewport, taken at `takenAt`. */
      seen: (width: number, height: number, takenAt = performance.now()) => fake.views[0].sink.viewport({ width, height }, takenAt),
      /** The pane's size, once the host has answered it. */
      async size(width: number, height: number, engagement = 'e1') {
        const answered = syncStates(viewer).length;
        viewer.send({ type: 'sync', width, height, dpr: 2, engagement });
        await vi.waitFor(() => expect(syncStates(viewer).length).toBeGreaterThan(answered));
      },
      writes: () => fake.calls.filter((call) => call.startsWith('viewport ') || call.startsWith('device ')),
      state: () => syncStates(viewer).at(-1),
    };
  }

  it('writes one size at a time, and a drag coalesces to the last size asked for meanwhile', async () => {
    const pane = await paneOn();
    pane.fake.gate('viewport s1 800x600@2');
    await pane.size(800, 600);
    for (let width = 810; width <= 900; width += 10) await pane.size(width, 600);
    expect(pane.writes()).toEqual(['viewport s1 800x600@2']);
    expect(pane.state()).toBe('applying');
    pane.fake.release('viewport s1 800x600@2');
    await vi.waitFor(() => expect(pane.writes()).toEqual(['viewport s1 800x600@2', 'viewport s1 900x600@2']));
    await flush();
    pane.seen(900, 600);
    await vi.waitFor(() => expect(pane.state()).toBe('synced'));
    // A size it holds is not written again.
    await pane.size(900, 600);
    expect(pane.writes()).toHaveLength(2);
  });

  it('judges a write only by a viewport taken after it landed, never by one begun before', async () => {
    const pane = await paneOn();
    await pane.size(800, 600);
    await vi.waitFor(() => expect(pane.writes()).toHaveLength(1));
    await flush();
    pane.seen(800, 600);
    await vi.waitFor(() => expect(pane.state()).toBe('synced'));

    // A poll begins measuring while the drag's next size is written, and
    // answers the size before it only once that write has landed.
    pane.fake.gate('viewport s1 900x600@2');
    await pane.size(900, 600);
    const begun = performance.now();
    pane.seen(800, 600, begun);
    pane.fake.release('viewport s1 900x600@2');
    await flush();
    pane.seen(800, 600, begun);
    await settled();
    expect(pane.state()).toBe('applying');
    pane.seen(900, 600);
    await vi.waitFor(() => expect(pane.state()).toBe('synced'));
  });

  it('stops syncing a browser another writer sized after its write settled, until the pane engages again', async () => {
    const pane = await paneOn();
    await pane.size(800, 600);
    await vi.waitFor(() => expect(pane.writes()).toHaveLength(1));
    await flush();
    // A frame in flight as the write landed is replaced within the settle time.
    pane.seen(1280, 720);
    pane.seen(800, 600);
    await settled();
    expect(pane.state()).toBe('synced');

    // An agent's `set viewport`.
    pane.seen(1024, 768);
    await vi.waitFor(() => expect(pane.state()).toBe('off'));
    // The pane's next size writes nothing; choosing Resize with pane again
    // reclaims the viewport, at a size it wrote before too.
    await pane.size(820, 600);
    expect(pane.state()).toBe('off');
    expect(pane.writes()).toHaveLength(1);
    await pane.size(800, 600, 'e2');
    await vi.waitFor(() => expect(pane.writes()).toEqual(['viewport s1 800x600@2', 'viewport s1 800x600@2']));
  });

  it('sizes a page shown anew, never reading its own size as another writer', async () => {
    const pane = await paneOn();
    const tabs = (active: string) => pane.fake.views[0].sink.state({ type: 'tabs', tabs: ['t1', 't2'].map((tabId) => ({ tabId, title: tabId, url: `http://localhost/${tabId}`, active: tabId === active })) });
    tabs('t1');
    await pane.size(800, 600);
    await vi.waitFor(() => expect(pane.writes()).toHaveLength(1));
    await flush();
    pane.seen(800, 600);

    // An agent opens a tab, which comes up at its own size.
    tabs('t2');
    pane.seen(1280, 720);
    await vi.waitFor(() => expect(pane.writes()).toEqual(['viewport s1 800x600@2', 'viewport s1 800x600@2']));
    await flush();
    pane.seen(800, 600);
    await settled();
    expect(pane.state()).toBe('synced');
  });

  it('ends sync for a Fixed resolution, which lands after the write in flight', async () => {
    const pane = await paneOn();
    pane.fake.gate('viewport s1 800x600@2');
    await pane.size(800, 600);
    const fixed = pane.host.request({ ...s1, op: 'device', name: 'iPhone 15' });
    await vi.waitFor(() => expect(pane.state()).toBe('off'));
    expect(pane.writes()).toEqual(['viewport s1 800x600@2']);
    pane.fake.release('viewport s1 800x600@2');
    expect((await fixed).ok).toBe(true);
    expect(pane.writes()).toEqual(['viewport s1 800x600@2', 'device s1 iPhone 15']);
    // A pane size still on its way is not a new engagement.
    await pane.size(820, 600);
    expect(pane.writes()).toHaveLength(2);
  });

  it('drops a Fixed resolution that waited on a write once a launch replaces the browser', async () => {
    const pane = await paneOn();
    pane.fake.gate('viewport s1 800x600@2');
    await pane.size(800, 600);
    const fixed = pane.host.request({ ...s1, op: 'viewport', width: 1024, height: 768, dpr: 1 });
    await flush();
    pane.fake.gate('stop s1');
    const relaunch = pane.host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/', headed: true });
    await vi.waitFor(() => expect(pane.fake.calls).toContain('stop s1'));
    pane.fake.release('viewport s1 800x600@2');
    expect(await fixed).toEqual({ ok: false, error: 'the browser is being relaunched or closed' });
    pane.fake.release('stop s1');
    expect((await relaunch).ok).toBe(true);
    expect(pane.writes()).toEqual(['viewport s1 800x600@2']);
  });

  it('drops a Fixed resolution that waited on a write through a whole relaunch', async () => {
    const pane = await paneOn();
    pane.fake.gate('viewport s1 800x600@2');
    await pane.size(800, 600);
    const fixed = pane.host.request({ ...s1, op: 'device', name: 'iPhone 15' });
    await flush();
    expect((await pane.host.request({ ...s1, op: 'launch', url: 'http://localhost:5173/' })).ok).toBe(true);
    pane.fake.release('viewport s1 800x600@2');
    expect(await fixed).toEqual({ ok: false, error: 'the browser is being relaunched or closed' });
    expect(pane.writes()).toEqual(['viewport s1 800x600@2']);
  });

  it('drops a Fixed resolution that waited on a write through shutdown', async () => {
    const pane = await paneOn();
    pane.fake.gate('viewport s1 800x600@2');
    await pane.size(800, 600);
    const fixed = pane.host.request({ ...s1, op: 'viewport', width: 1024, height: 768, dpr: 1 });
    await flush();
    await pane.host.close();
    pane.fake.release('viewport s1 800x600@2');
    expect(await fixed).toEqual({ ok: false, error: 'the browser host is shutting down' });
    expect(pane.writes()).toEqual(['viewport s1 800x600@2']);
  });

  it('never sizes a popped-out window', async () => {
    const pane = await paneOn({ headed: true });
    pane.viewer.send({ type: 'sync', width: 800, height: 600, dpr: 2, engagement: 'e1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pane.writes()).toEqual([]);
    expect(pane.state()).toBeUndefined();
  });
});

