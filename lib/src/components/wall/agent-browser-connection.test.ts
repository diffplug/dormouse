import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeViewerFrame } from '../../lib/platform/browser-automation';
import { createAgentBrowserConnection, type AgentBrowserConnectionDeps } from './agent-browser-connection';

class WebSocketMock {
  static instances: WebSocketMock[] = [];
  static OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    WebSocketMock.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** A connection to a host that grants `ws://viewer/<n>` for each connect. */
function connect(deps: Partial<AgentBrowserConnectionDeps> = {}) {
  let granted = 0;
  const viewUrl = vi.fn(async () => `ws://127.0.0.1:9/view/${++granted}`);
  const connection = createAgentBrowserConnection({ session: 'dormouse.1.default', stream: 1234, viewUrl, ...deps });
  return { connection, viewUrl };
}

const socket = () => WebSocketMock.instances.at(-1)!;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketMock);
  WebSocketMock.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('viewer socket connection', () => {
  it('dials the URL the host grants, taking frames as binary', async () => {
    const { connection } = connect();
    await flush();
    expect(socket().url).toBe('ws://127.0.0.1:9/view/1');
    expect(socket().binaryType).toBe('arraybuffer');
    connection.dispose();
    expect(socket().closed).toBe(true);
  });

  it('decodes each binary frame, and forwards url and a popped-out page as events', async () => {
    const { connection } = connect();
    const events: unknown[] = [];
    connection.subscribe((event) => { if (event.type !== 'debug') events.push(event); });
    await flush();
    const provisional = encodeViewerFrame({ kind: 'provisional', jpeg: new Uint8Array([0xff, 0xd8, 1]), size: { width: 800, height: 600 } });
    const crisp = encodeViewerFrame({ kind: 'crisp', jpeg: new Uint8Array([0xff, 0xd8, 2]) });
    socket().emitMessage(provisional.buffer);
    socket().emitMessage(crisp.buffer);
    // Not a frame: a short or unknown binary message is ignored.
    socket().emitMessage(new Uint8Array([9, 0, 0]).buffer);
    socket().emitMessage(JSON.stringify({ type: 'url', url: 'https://example.com/slow' }));
    socket().emitMessage(JSON.stringify({ type: 'url' }));
    socket().emitMessage(JSON.stringify({ type: 'page', url: 'https://example.com/headed', title: 'Headed' }));
    expect(events.map((event) => {
      const e = event as { type: string; kind?: string; jpeg?: Uint8Array };
      return e.type === 'frame' ? { ...e, jpeg: [...e.jpeg!] } : e;
    })).toEqual([
      { type: 'connection-open', stream: 1234 },
      { type: 'frame', kind: 'provisional', jpeg: [0xff, 0xd8, 1], size: { width: 800, height: 600 } },
      { type: 'frame', kind: 'crisp', jpeg: [0xff, 0xd8, 2] },
      { type: 'url', url: 'https://example.com/slow' },
      { type: 'page', url: 'https://example.com/headed', title: 'Headed' },
    ]);
    connection.dispose();
  });

  it('asks the host for a fresh URL on every reconnect, counting a refusal as a failure', async () => {
    vi.useFakeTimers();
    try {
      const { connection, viewUrl } = connect();
      const closes: number[] = [];
      connection.subscribe((event) => { if (event.type === 'connection-close') closes.push(event.failures); });
      await vi.advanceTimersByTimeAsync(0);
      socket().close();
      await vi.advanceTimersByTimeAsync(2100);
      // Grants are single-use: the reconnect asked again.
      expect(viewUrl).toHaveBeenCalledTimes(2);
      expect(socket().url).toBe('ws://127.0.0.1:9/view/2');
      // An open resets the count; a refused URL adds to it like a close.
      viewUrl.mockRejectedValueOnce(new Error('the browser is being relaunched or closed'));
      socket().close();
      await vi.advanceTimersByTimeAsync(2100);
      expect(closes).toEqual([1, 1, 2]);
      expect(viewUrl).toHaveBeenCalledTimes(3);
      connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores transient empty tabs after a real tab list', async () => {
    const { connection } = connect();
    await flush();
    socket().emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
    }));
    expect(connection.snapshot().tabs).toHaveLength(1);
    socket().emitMessage(JSON.stringify({ type: 'tabs', tabs: [] }));
    expect(connection.snapshot().tabs).toEqual([
      { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
    ]);
  });

  it('selects a newly opened tab that is not active, and not one already active on a duplicate URL', async () => {
    const selectTab = vi.fn(async () => ({ ok: true }));
    const { connection } = connect({ selectTab });
    await flush();
    const tab = (tabId: string, active: boolean, url = 'https://dormouse.sh/') => ({ tabId, title: 'Dormouse', url, active });
    socket().emitMessage(JSON.stringify({ type: 'tabs', tabs: [tab('t1', true)] }));
    socket().emitMessage(JSON.stringify({ type: 'tabs', tabs: [tab('t1', false), tab('t2', true)] }));
    expect(selectTab).not.toHaveBeenCalled();
    socket().emitMessage(JSON.stringify({ type: 'tabs', tabs: [tab('t1', false), tab('t2', true), tab('t3', false, 'https://other.example/')] }));
    expect(selectTab).toHaveBeenCalledExactlyOnceWith('t3');
    connection.dispose();
  });
});
