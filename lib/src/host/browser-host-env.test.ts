// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createBrowserHost } from './browser-host';
import { fakeProvider } from './browser-host-test-utils';
const request = { provider: 'agent-browser', binding: { session: 'shell-test' }, op: 'launch', headed: false, url: 'https://example.com' } as const;
it('retains one host-only environment per session and refreshes after close', async () => {
  const fake = fakeProvider();
  const env = { PATH: '/shell/bin', SECRET: 'private' };
  const launchEnv = vi.fn(async () => env);
  const bind = vi.spyOn(fake.provider, 'bind');
  const host = createBrowserHost({ launchEnv, writeClipboardText() {}, providers: { 'agent-browser': () => fake.provider } });
  try {
    const results = await Promise.all([host.request(request), host.request(request)]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('private');
    expect(launchEnv).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls.every(([b]) => b.env === env)).toBe(true);
    await host.request({ ...request, op: 'close' });
    await host.request(request);
    expect(launchEnv).toHaveBeenCalledTimes(2);
  } finally { await host.close(); }
});
it.each([true, false])('cancels startup before opening (request ids: %s)', async (withId) => {
  const fake = fakeProvider();
  let resolve!: (env: NodeJS.ProcessEnv) => void;
  const launchEnv = vi.fn(() => new Promise<NodeJS.ProcessEnv>(r => { resolve = r; }));
  const host = createBrowserHost({ launchEnv, writeClipboardText() {}, providers: { 'agent-browser': () => fake.provider } });
  try {
    const opening = host.request({ ...request, ...(withId ? { requestId: 'shell-opening' } : {}) });
    const closing = host.request({ ...request, op: 'close', ...(withId ? { cancels: ['shell-opening'] } : {}) });
    resolve({ PATH: '/shell/bin' });
    expect(await opening).toMatchObject({ ok: false, error: 'the browser was closed' });
    expect(await closing).toMatchObject({ ok: true });
    expect(fake.calls.some(c => c.startsWith('open '))).toBe(false);
  } finally { await host.close(); }
});
it('retries shell initialization after failure', async () => {
  const fake = fakeProvider();
  const launchEnv = vi.fn().mockRejectedValueOnce(new Error('shell failed')).mockResolvedValue({ PATH: '/shell/bin' });
  const host = createBrowserHost({ launchEnv, writeClipboardText() {}, providers: { 'agent-browser': () => fake.provider } });
  try {
    expect(await host.request(request)).toMatchObject({ ok: false, error: 'shell failed' });
    expect(await host.request(request)).toMatchObject({ ok: true });
    expect(launchEnv).toHaveBeenCalledTimes(2);
  } finally { await host.close(); }
});
