// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createBrowserHost } from './browser-host';
import { fakeProvider } from './browser-host-test-utils';

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
    expect(await launching).toMatchObject({ ok: true, session: 'dormouse.1.default', wsPort: 4321 });
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
    expect(await first).toMatchObject({ ok: true, wsPort: 4321 });
    expect(await superseded).toEqual({ ok: false, error: 'the browser was closed' });
    expect(await Promise.all(closes)).toEqual([{ ok: true }, { ok: true }]);
    expect(await third).toMatchObject({ ok: true, wsPort: 4321 });
    expect(fake.calls).toEqual([
      'stop dormouse.1.tool.t', 'open dormouse.1.tool.t http://localhost:6006/',
      'close dormouse.1.tool.t', 'close dormouse.1.tool.t',
      'stop dormouse.1.tool.t', 'open dormouse.1.tool.t http://localhost:6006/',
    ]);
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
    expect(launched).toMatchObject({ ok: true, wsPort: 4321 });
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
