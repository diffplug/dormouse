/**
 * A fake `BrowserProvider` for tests that run the real browser host
 * (`createBrowserHost`) — its own tests, and the webview's against it.
 */
import type { BrowserProvider, ProviderBinding } from './browser-host';

/** A provider that records every primitive the host calls, in order; `stop`,
 *  `close` and `open` can be held open by a test. */
export function fakeProvider() {
  const calls: string[] = [];
  const held = new Map<string, () => void>();
  const hold = (name: string) => new Promise<void>((resolve) => { held.set(name, resolve); });
  const gates = new Set<string>();
  const step = async (name: string) => {
    calls.push(name);
    if (gates.has(name)) await hold(name);
  };
  let tabs: { tabId: string; url: string }[] = [];
  const provider: BrowserProvider<ProviderBinding> = {
    pollMs: 1,
    bind: (binding) => binding,
    identity: (b) => b.session,
    describe: (b) => ({ session: b.session }),
    find: async () => ({ gone: 'not running', named: false }),
    stop: async (b) => { await step(`stop ${b.session}`); },
    open: async (b, url, headed) => {
      await step(`open ${b.session} ${url ?? 'blank'}${headed ? ' headed' : ''}`);
      return { exitCode: 0, stderr: '' };
    },
    probe: async () => ({ wsPort: 4321 }),
    close: async (b) => { await step(`close ${b.session}`); },
    listTabs: async () => tabs,
    act: async (b, act) => {
      calls.push(`${act.op} ${b.session}${act.op === 'tab' ? ` ${act.action} ${act.tabId}` : ''}`);
      return { ok: true };
    },
    evaluate: async () => '',
    screenshot: async () => ({ bytes: new Uint8Array([1]) }),
    streamUrl: async (port) => `ws://127.0.0.1:${port}`,
  };
  return {
    provider,
    calls,
    /** Hold the named primitive call until `release(name)`. */
    gate: (name: string) => gates.add(name),
    release: (name: string) => { gates.delete(name); held.get(name)?.(); },
    setTabs: (next: typeof tabs) => { tabs = next; },
  };
}
