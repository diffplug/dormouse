/**
 * A fake `BrowserProvider` for tests that run the real browser host
 * (`createBrowserHost`) — its own tests, and the webview's against it.
 */
import { WebSocket } from 'ws';
import type { BrowserProvider, ProviderBinding } from './browser-host';
import type { Upstream, ViewerSink } from './browser-viewer';
import { decodeViewerFrame, type ViewerBrowserInput, type ViewerFrame, type ViewerState } from '../lib/platform/browser-automation';

/** One subscription the host made through the fake provider's `view`. */
export interface FakeView {
  session: string;
  stream: number;
  headed: boolean;
  sink: ViewerSink;
  inputs: ViewerBrowserInput[];
  closed: boolean;
}

/** A provider that records every primitive the host calls, in order; `stop`,
 *  `close`, `open`, `screenshot` and each viewport or device write can be
 *  held open by a test. */
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
  const views: FakeView[] = [];
  let shot = 0;
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
    probe: async () => ({ stream: 4321 }),
    close: async (b) => { await step(`close ${b.session}`); },
    listTabs: async () => tabs,
    closeTab: async (b, tabId) => { calls.push(`tab ${b.session} close ${tabId}`); },
    act: async (b, act) => {
      const args = act.op === 'tab' ? ` ${act.action} ${act.tabId}`
        : act.op === 'viewport' ? ` ${act.width}x${act.height}@${act.dpr}`
        : act.op === 'device' ? ` ${act.name}` : '';
      await step(`${act.op} ${b.session}${args}`);
      return { ok: true };
    },
    evaluate: async () => '',
    // Each capture a distinct JPEG-ish frame, so none dedups against the last.
    screenshot: async (b) => {
      await step(`screenshot ${b.session}`);
      shot += 1;
      return { bytes: new Uint8Array([0xff, 0xd8, shot]) };
    },
    view: async (b, stream, { headed }, sink): Promise<Upstream> => {
      calls.push(`view ${b.session} ${stream}${headed ? ' headed' : ''}`);
      const view: FakeView = { session: b.session, stream, headed, sink, inputs: [], closed: false };
      views.push(view);
      return {
        capturable: true,
        input: (message) => { view.inputs.push(message); return true; },
        close: () => { view.closed = true; },
      };
    },
  };
  return {
    provider,
    calls,
    views,
    /** Hold the named primitive call until `release(name)`. */
    gate: (name: string) => gates.add(name),
    release: (name: string) => { gates.delete(name); held.get(name)?.(); },
    setTabs: (next: typeof tabs) => { tabs = next; },
  };
}

/** The webview's end of a viewer socket, as a test holds it: what arrived,
 *  frames decoded, and a way to send input. */
export interface TestViewer {
  socket: WebSocket;
  frames: ViewerFrame[];
  states: ViewerState[];
  send(message: object): void;
  /** Settles with the close code once the host ends the socket. */
  closed: Promise<number>;
  /** The reason the host closed it with, once it has. */
  reason?: string;
}

/** Connect to a viewer socket URL as the webview does, once it is open. */
export async function openViewer(url: string): Promise<TestViewer> {
  const socket = new WebSocket(url);
  const frames: ViewerFrame[] = [];
  const states: ViewerState[] = [];
  socket.on('error', () => {});
  socket.on('message', (data: Buffer, isBinary) => {
    if (!isBinary) {
      states.push(JSON.parse(data.toString()) as ViewerState);
      return;
    }
    const frame = decodeViewerFrame(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    if (frame) frames.push(frame);
  });
  const viewer: TestViewer = { socket, frames, states, send: (message) => socket.send(JSON.stringify(message)), closed: Promise.resolve(0) };
  viewer.closed = new Promise<number>((resolve) => socket.once('close', (code, reason) => {
    viewer.reason = reason.toString();
    resolve(code);
  }));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_req, res) => reject(new Error(`viewer refused: ${res.statusCode}`)));
  });
  return viewer;
}
