import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBrowserConnection } from './agent-browser-connection';

class WebSocketMock {
  static instances: WebSocketMock[] = [];
  static OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
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

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketMock);
  WebSocketMock.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent-browser connection', () => {
  it('closes the stream websocket when disposed', async () => {
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
    });

    await Promise.resolve();
    const ws = WebSocketMock.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:1234');

    connection.dispose();

    expect(ws.closed).toBe(true);
  });

  it('ignores transient empty tabs after a real tab list', async () => {
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
    });

    await Promise.resolve();
    const ws = WebSocketMock.instances[0];
    ws.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
    }));

    expect(connection.snapshot().tabs).toHaveLength(1);

    ws.emitMessage(JSON.stringify({ type: 'tabs', tabs: [] }));

    expect(connection.snapshot().tabs).toEqual([
      { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
    ]);
  });

  it('does not force-select an active provisional duplicate-url tab', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
      runCommand,
    });

    await Promise.resolve();
    const ws = WebSocketMock.instances[0];
    ws.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
    }));
    ws.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [
        { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: false },
        { tabId: 't2', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
      ],
    }));

    expect(runCommand).not.toHaveBeenCalled();
  });
});
