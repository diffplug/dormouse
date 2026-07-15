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

  it('drops byte-identical frame re-broadcasts (daemon heartbeat) but forwards real changes', async () => {
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
      wantFrameData: () => true,
    });
    let pulses = 0;
    const provisionalFrames: Array<string | undefined> = [];
    connection.subscribe((event) => {
      if (event.type === 'frame-pulse') {
        pulses += 1;
        provisionalFrames.push(event.data);
      }
    });

    await Promise.resolve();
    const ws = WebSocketMock.instances[0];
    const frameA = JSON.stringify({ type: 'frame', data: 'AAAAAAAAAA' });
    const frameB = JSON.stringify({ type: 'frame', data: 'BBBBBBBBBB' });

    ws.emitMessage(frameA); // first frame — primes
    ws.emitMessage(frameA); // identical re-broadcast — dropped
    ws.emitMessage(frameA); // identical re-broadcast — dropped
    expect(pulses).toBe(1);

    ws.emitMessage(frameB); // real change — forwarded
    ws.emitMessage(frameB); // identical — dropped
    expect(pulses).toBe(2);

    ws.emitMessage(frameA); // changed again — forwarded
    expect(pulses).toBe(3);
    expect(provisionalFrames).toEqual(['AAAAAAAAAA', 'BBBBBBBBBB', 'AAAAAAAAAA']);
  });

  it('parses a large stream frame for provisional painting', async () => {
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
      wantFrameData: () => true,
    });
    const frames: string[] = [];
    connection.subscribe((event) => {
      if (event.type === 'frame-pulse' && event.data) frames.push(event.data);
    });

    await Promise.resolve();
    const data = 'A'.repeat(20_000);
    WebSocketMock.instances[0].emitMessage(JSON.stringify({
      type: 'frame',
      data,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    }));

    expect(frames).toEqual([data]);
  });

  it('drops identical tab-snapshot re-broadcasts but forwards real changes', async () => {
    const connection = createAgentBrowserConnection({
      session: 'dormouse.1.default',
      streamPort: 1234,
    });
    let tabsEvents = 0;
    connection.subscribe((event) => { if (event.type === 'tabs') tabsEvents += 1; });

    await Promise.resolve();
    const ws = WebSocketMock.instances[0];
    const snapshot = JSON.stringify({
      type: 'tabs',
      tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
    });

    ws.emitMessage(snapshot); // first — emits
    ws.emitMessage(snapshot); // identical heartbeat — dropped
    ws.emitMessage(snapshot); // identical heartbeat — dropped
    expect(tabsEvents).toBe(1);

    // A genuine change (new tab) alters the signature and is forwarded.
    ws.emitMessage(JSON.stringify({
      type: 'tabs',
      tabs: [
        { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: false },
        { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: true },
      ],
    }));
    expect(tabsEvents).toBe(2);
  });

  it('re-primes after a reconnect so the first identical frame/tabs still forwards', async () => {
    vi.useFakeTimers();
    try {
      const connection = createAgentBrowserConnection({
        session: 'dormouse.1.default',
        streamPort: 1234,
      });
      let pulses = 0;
      let tabsEvents = 0;
      connection.subscribe((event) => {
        if (event.type === 'frame-pulse') pulses += 1;
        if (event.type === 'tabs') tabsEvents += 1;
      });

      // Flush connect()'s async getStreamUrl microtask + the mock's queued onopen.
      await vi.advanceTimersByTimeAsync(0);
      const ws = WebSocketMock.instances[0];
      const frame = JSON.stringify({ type: 'frame', data: 'AAAAAAAAAA' });
      const snapshot = JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
      });
      ws.emitMessage(frame);
      ws.emitMessage(snapshot);
      expect(pulses).toBe(1);
      expect(tabsEvents).toBe(1);

      // Socket drops; the connection resets dedupe state and schedules a reconnect
      // (backoff ~2s for the first failure). Advance past it to open a new socket.
      ws.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      await vi.advanceTimersByTimeAsync(2100);
      const ws2 = WebSocketMock.instances[WebSocketMock.instances.length - 1];
      expect(ws2).not.toBe(ws);

      // The reconnected stream re-sends the same frame/tabs; they must re-prime, not
      // be swallowed as duplicates of the pre-disconnect state.
      ws2.emitMessage(frame);
      ws2.emitMessage(snapshot);
      expect(pulses).toBe(2);
      expect(tabsEvents).toBe(2);

      connection.dispose();
    } finally {
      vi.useRealTimers();
    }
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
