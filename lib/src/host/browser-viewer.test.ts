// @vitest-environment node
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { decodeViewerFrame, type ViewerFrame, type ViewerState } from '../lib/platform/browser-automation';
import { BrowserView, PROVISIONAL_INPUT_WINDOW_MS, createViewerServer, parseViewerInput, type Upstream } from './browser-viewer';
import { openViewer } from './browser-host-test-utils';

/** The webview's socket as a view sees it: what was sent, and input to send. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closedWith: number | undefined;
  send(data: string | Uint8Array) { this.sent.push(data); }
  close(code: number) {
    this.readyState = WebSocket.CLOSED;
    this.closedWith = code;
    this.emit('close', code);
  }
  frames(): ViewerFrame[] {
    return this.sent.filter((data): data is Uint8Array => typeof data !== 'string')
      .map((data) => decodeViewerFrame(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)!);
  }
  kinds() { return this.frames().map((frame) => `${frame.kind} ${frame.jpeg[0]}`); }
  states(): ViewerState[] { return this.sent.filter((data): data is string => typeof data === 'string').map((data) => JSON.parse(data)); }
  input(message: object) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

const jpeg = (n: number) => new Uint8Array([n]);

/** A view on a fake socket whose captures the test answers, in order. */
function makeView(opts: { headed?: boolean; capturable?: boolean } = {}) {
  const socket = new FakeSocket();
  const captures: ((jpeg: Uint8Array | undefined) => void)[] = [];
  const capture = vi.fn(() => new Promise<Uint8Array | undefined>((resolve) => { captures.push(resolve); }));
  const inputs: unknown[] = [];
  const upstream: Upstream = {
    capturable: opts.capturable ?? true,
    input: (message) => { inputs.push(message); return true; },
    close: vi.fn(),
  };
  const view = new BrowserView(socket as unknown as WebSocket, { headed: opts.headed ?? false, capture, onClose: vi.fn() });
  view.attach(upstream);
  return { socket, view, capture, captures, inputs, upstream };
}

describe('a viewer socket', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the first stream frame at once, then the capture that sharpens it, and no other stream frame', async () => {
    const { socket, view, capture, captures } = makeView();
    view.frame(jpeg(1), { width: 800, height: 600 });
    expect(socket.kinds()).toEqual(['provisional 1']);
    expect(socket.frames()[0].size).toEqual({ width: 800, height: 600 });
    await vi.advanceTimersByTimeAsync(100);
    expect(capture).toHaveBeenCalledOnce();
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.kinds()).toEqual(['provisional 1', 'crisp 9']);
    // An animated page: its frames only pulse the loop, which keeps capturing.
    view.frame(jpeg(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(socket.kinds()).toEqual(['provisional 1', 'crisp 9']);
    // A static page pulses nothing, so it costs nothing.
    captures[1](jpeg(10));
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledTimes(2);
    // The crisp frame carries the viewport's size too.
    expect(socket.frames().at(-1)).toMatchObject({ kind: 'crisp', size: { width: 800, height: 600 } });
  });

  it('sends a byte-identical capture only over a provisional paint, or to a canvas that asks again', async () => {
    const { socket, view, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    view.frame(jpeg(2));
    await vi.advanceTimersByTimeAsync(300);
    captures[1](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    // Still what the canvas shows: not sent again.
    expect(socket.kinds()).toEqual(['provisional 1', 'crisp 9']);

    // Input paints the stream over it, so the same capture sharpens it again.
    socket.input({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    view.frame(jpeg(3));
    await vi.advanceTimersByTimeAsync(PROVISIONAL_INPUT_WINDOW_MS + 100);
    captures[2](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.kinds()).toEqual(['provisional 1', 'crisp 9', 'provisional 3', 'crisp 9']);

    // A canvas that mounted blank gets the last frame back.
    socket.input({ type: 'repaint' });
    expect(socket.kinds().at(-1)).toBe('crisp 9');
  });

  it('keeps a capture a provisional paint superseded owed, with nothing left to pulse it', async () => {
    const { socket, view, capture, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(capture).toHaveBeenCalledOnce();
    // A single pointer move mid-capture: one provisional paint, then quiet.
    socket.input({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    view.frame(jpeg(2));
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.kinds()).toEqual(['provisional 1', 'provisional 2']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(2);
    captures[1](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.kinds()).toEqual(['provisional 1', 'provisional 2', 'crisp 9']);
  });

  it('spends no captures while input keeps the stream painting, then one settled capture', async () => {
    const { socket, view, capture, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(0);
    // Sustained typing: a key and a changed frame every 50 ms.
    for (let i = 0; i < 12; i++) {
      socket.input({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
      view.frame(jpeg(20 + i));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(capture).toHaveBeenCalledOnce();
    expect(socket.kinds().filter((kind) => kind.startsWith('provisional'))).toHaveLength(13);
    await vi.advanceTimersByTimeAsync(600);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('coalesces the frames that arrive during a capture into one follow-up', async () => {
    const { view, capture, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 3; i++) view.frame(jpeg(2 + i));
    expect(capture).toHaveBeenCalledOnce();
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(300);
    expect(capture).toHaveBeenCalledTimes(2);
    captures[1](jpeg(10));
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('paints the stream while a capture is overdue, never re-issues it, and sends it when it lands', async () => {
    const { socket, view, capture, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    // Held behind a page-loading `open`: past twice the average, at least 400 ms.
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 20; i++) {
      view.frame(jpeg(10 + i));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(capture).toHaveBeenCalledOnce();
    expect(socket.kinds()).toHaveLength(21);
    // Newer than every overdue paint, so it is sent; the wait's frames owe one more.
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.kinds().at(-1)).toBe('crisp 9');
    expect(capture).toHaveBeenCalledTimes(2);
    // The wait timed the page load, not a capture: the next is overdue as soon.
    await vi.advanceTimersByTimeAsync(500);
    view.frame(jpeg(50));
    expect(socket.kinds().at(-1)).toBe('provisional 50');

    // One that fails still leaves the wait's frames a capture owed.
    captures[1](undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('paints every changed frame of a browser it cannot capture, and none for a headed viewer', async () => {
    const watched = makeView({ capturable: false });
    for (let i = 0; i < 3; i++) watched.view.frame(jpeg(i));
    await vi.advanceTimersByTimeAsync(1000);
    expect(watched.socket.kinds()).toEqual(['provisional 0', 'provisional 1', 'provisional 2']);
    expect(watched.capture).not.toHaveBeenCalled();

    const headed = makeView({ headed: true });
    headed.view.frame(jpeg(1));
    headed.view.state({ type: 'url', url: 'https://example.com/' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(headed.socket.frames()).toEqual([]);
    expect(headed.capture).not.toHaveBeenCalled();
    expect(headed.socket.states()).toEqual([{ type: 'url', url: 'https://example.com/' }]);
  });

  it('captures the tab an active-tab change shows, and nothing for other tab edits', async () => {
    const { view, capture, captures } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(1000);
    const tabs = (active: string, title: string) => ({
      type: 'tabs' as const,
      tabs: ['t1', 't2'].map((tabId) => ({ tabId, url: `https://${tabId}.example/`, title, active: tabId === active })),
    });
    view.state(tabs('t1', 'One'));
    view.state(tabs('t1', 'Renamed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledOnce();
    view.state(tabs('t2', 'Renamed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('forwards only validated input, and closes a socket whose input backs up', async () => {
    const { socket, inputs, view, upstream } = makeView();
    socket.input({ type: 'input_mouse', eventType: 'mousePressed', x: 3, y: 4, button: 'left', buttons: 1, clickCount: 1, modifiers: 2, extra: 'dropped' });
    socket.input({ type: 'input_mouse', eventType: 'mouseMoved', x: Infinity, y: 0 });
    socket.input({ type: 'eval', script: 'document.cookie' });
    socket.emit('message', Buffer.from('not json'), false);
    socket.emit('message', Buffer.from([1, 2, 3]), true);
    expect(inputs).toEqual([{ type: 'input_mouse', eventType: 'mousePressed', x: 3, y: 4, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 }]);

    upstream.input = () => false;
    socket.input({ type: 'input_text', text: 'x' });
    expect(socket.closedWith).toBe(1008);
    // Closing ends the provider's subscription.
    expect(upstream.close).toHaveBeenCalledOnce();
    view.frame(jpeg(1));
    expect(socket.frames()).toEqual([]);
  });

  it('ends at once when the host closes it, capturing nothing while the webview has yet to answer', async () => {
    const { socket, view, capture, captures, upstream } = makeView();
    view.frame(jpeg(1));
    await vi.advanceTimersByTimeAsync(100);
    view.frame(jpeg(2));
    // The browser is relaunching: a slow webview has not answered the close.
    socket.close = vi.fn() as unknown as FakeSocket['close'];
    view.close(1001, 'the browser was relaunched or closed');
    expect(upstream.close).toHaveBeenCalledOnce();
    captures[0](jpeg(9));
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledOnce();
    expect(socket.kinds()).toEqual(['provisional 1']);
  });

  it('tells the webview a browser that went away on its own is gone', () => {
    const { socket, view } = makeView();
    view.gone();
    expect(socket.states()).toEqual([{ type: 'status', connected: false, screencasting: false }]);
    expect(socket.closedWith).toBe(1000);
  });
});

describe('parseViewerInput', () => {
  it('rebuilds each shape field by field, bounded, and refuses the rest', () => {
    expect(parseViewerInput(JSON.stringify({ type: 'input_mouse', eventType: 'mouseWheel', x: 1, y: 2, button: 'evil', buttons: 255, clickCount: 9, modifiers: 255, deltaX: 'x', deltaY: 5 })))
      .toEqual({ type: 'input_mouse', eventType: 'mouseWheel', x: 1, y: 2, button: 'none', buttons: 31, clickCount: 3, modifiers: 15, deltaX: 0, deltaY: 5 });
    expect(parseViewerInput(JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'c'.repeat(200), text: 't'.repeat(2000), windowsVirtualKeyCode: 65.5, modifiers: 16 })))
      .toEqual({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'c'.repeat(100), text: 't'.repeat(1000), windowsVirtualKeyCode: 0, modifiers: 0 });
    for (const refused of [
      { type: 'input_mouse', eventType: 'click', x: 1, y: 1 },
      { type: 'input_mouse', eventType: 'mouseMoved', x: 1e7, y: 1 },
      { type: 'input_keyboard', eventType: 'keyPress', key: 'a' },
      { type: 'input_keyboard', eventType: 'keyDown', key: 'k'.repeat(101) },
      { type: 'input_text', text: 'x'.repeat(8193) },
      { type: 'input_touch' },
      null,
      7,
    ]) {
      expect(parseViewerInput(JSON.stringify(refused)), JSON.stringify(refused)).toBeNull();
    }
    expect(parseViewerInput('{')).toBeNull();
  });
});

describe('the viewer listener', () => {
  it('upgrades a granted socket once, addressed by its own loopback name, and refuses everything else', async () => {
    const server = createViewerServer();
    const opened: WebSocket[] = [];
    try {
      const url = await server.grant((socket) => opened.push(socket));
      const { port, pathname } = new URL(url);
      expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/view\/[a-f0-9]{64}$/);

      // A rebinding page arrives under its own name.
      const rebound = new WebSocket(url, { headers: { host: `attacker.example:${port}` } });
      const refused = await new Promise<number>((resolve) => rebound.once('unexpected-response', (_req, res) => resolve(res.statusCode!)));
      expect(refused).toBe(403);
      // A guessed token, and a plain request, get nothing.
      await expect(openViewer(`ws://127.0.0.1:${port}/view/${'0'.repeat(64)}`)).rejects.toThrow('403');
      const status = await new Promise<number>((resolve) => httpRequest({ host: '127.0.0.1', port, path: pathname }, (res) => resolve(res.statusCode!)).end());
      expect(status).toBe(403);

      const viewer = await openViewer(url);
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      // Single-use: the same URL opens nothing again.
      await expect(openViewer(url)).rejects.toThrow('403');
      viewer.socket.close();
    } finally {
      await server.close();
    }
  });
});
