/**
 * The page standing in for Pocket. A frame's traffic reaches this window exactly
 * as it would in Pocket, through the shipped worker, bootstrap page and bridge,
 * and a fake OpenFrame answers it here, so the check needs no session or pairing.
 */
import { FRAME_BOOTSTRAP_PATH, IFRAME_SANDBOX } from 'remote-lib-common';
import type { FrameRequestInit, FrameResponse, FrameSocketHandlers, OpenFrame } from '../../lib/src/remote/client/frame-client';
import { serveFrame } from '../../lib/src/remote/frame-origin/frame-bridge';
import { tunnelSocketShim } from '../../lib/src/host/iframe-proxy-rewrite';
import { IFRAME_ALLOW } from '../../lib/src/lib/iframe-policy';

declare const FRAMED_PAGE: string;
const FRAME_ORIGIN: string = (document.documentElement.dataset.frameOrigin ?? '');
const CASE: string = document.documentElement.dataset.case ?? '';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
const list = document.getElementById('list')!;
const headline = document.getElementById('headline')!;

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  const row = document.createElement('li');
  row.className = ok ? 'pass' : 'fail';
  row.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`;
  list.append(row);
}

const sumOf = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum = (sum + bytes[i]!) >>> 0;
  return sum;
};

let cancelled = false;

/**
 * The Pocket page's own storage is the control: it says there was a last run, in
 * this browser context, for the frame's stores to be judged against.
 */
const RUNS_KEY = 'frame-check-runs';
const priorRuns = Number(localStorage.getItem(RUNS_KEY) ?? 0);
const lastRunAt = Number(localStorage.getItem('frame-check-last') ?? 0);
localStorage.setItem(RUNS_KEY, String(priorRuns + 1));
localStorage.setItem('frame-check-last', String(Date.now()));

/** One store's verdict on what it kept from the last run. */
function recordStored(name: string, previous: string | null, error?: string): void {
  if (error) return record(`frame ${name} usable`, false, error);
  if (priorRuns === 0) return record(`frame ${name} survives`, true, 'first run here: set');
  if (previous === null) return record(`frame ${name} survives`, false, 'LOST since the last run');
  record(`frame ${name} survives`, true, `kept from ${Math.round((Date.now() - Number(previous)) / 1000)} s ago`);
}
const text = (body: string, type = 'text/plain', status = 200, headers: [string, string][] = []): FrameResponse => ({
  status, statusText: 'OK', headers: [['content-type', type], ...headers], body: new Blob([body]).stream(),
});
const chunked = (chunks: number, size: number, gapMs = 0): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === chunks) return controller.close();
      if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(new Uint8Array(size).fill(sent % 251));
      sent += 1;
    },
  });
};

const fakeFrame = {
  id: 'check', path: '/page.html', url: 'http://localhost/', close() {},
  async request(init: FrameRequestInit): Promise<FrameResponse> {
    const { pathname, searchParams } = new URL(init.path, FRAME_ORIGIN);
    switch (pathname) {
      case '/page.html':
        return text(`<!doctype html><title>framed</title><script>${tunnelSocketShim()}</script><p>framed page</p><script src="/page.js"></script>`, 'text/html');
      case '/page.js':
        return text(FRAMED_PAGE, 'text/javascript');
      case '/nested.html':
        return text(`<!doctype html><script>parent.postMessage({kind:'nested',controlled:!!navigator.serviceWorker.controller},'*')</script>`, 'text/html');
      case '/editor-worker.js':
        return text(`postMessage('worker-ran')`, 'text/javascript');
      case '/blob': {
        const bytes = Number(searchParams.get('bytes'));
        const size = 192 * 1024;
        const chunks = Math.floor(bytes / size);
        let sum = 0;
        for (let i = 0; i < chunks; i += 1) sum = (sum + (i % 251) * size) >>> 0;
        return { status: 200, statusText: 'OK', headers: [['x-sum', String(sum)], ['access-control-expose-headers', 'x-sum']], body: chunked(chunks, size) };
      }
      case '/slow':
        return { status: 200, statusText: 'OK', headers: [], body: chunked(4, 1024, 400) };
      case '/never':
        return {
          status: 200, statusText: 'OK', headers: [],
          body: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(8)); },
            cancel() { cancelled = true; },
          }),
        };
      case '/echo': {
        const origin = init.headers.find(([name]) => name.toLowerCase() === 'origin')?.[1];
        return text(JSON.stringify({ length: init.body?.length ?? 0, sum: sumOf(init.body ?? new Uint8Array(0)), origin }), 'application/json');
      }
      case '/empty':
        return { status: 204, statusText: 'No Content', headers: [], body: new Blob([]).stream() };
      case '/redirect':
        return { status: 302, statusText: 'Found', headers: [['location', '/after']], body: new Blob([]).stream() };
      case '/after':
        return text('after');
      default:
        if (pathname.startsWith('/m/')) return text(`m${pathname.slice(3)}`);
        return text('not found', 'text/plain', 404);
    }
  },
  async openSocket(_path: string, _protocols: string[], handlers: FrameSocketHandlers) {
    return {
      protocol: 'vite-hmr', extensions: '',
      send: async (data: Uint8Array, binary: boolean) => handlers.onMessage(data, binary),
      close: (code?: number, reason?: string) => handlers.onClose(code ?? 1000, reason ?? ''),
    };
  },
} as OpenFrame;

const withTimeout = <T,>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms))]);

/** The frame origin's own probe: why registration fails, where the real page says nothing. */
function probe(): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = `${FRAME_ORIGIN}/__dormouse-frame/probe.html`;
    const timer = setTimeout(() => {
      record('frame origin loads in the frame', false, 'no answer in 15 s');
      resolve();
    }, 15000);
    addEventListener('message', (event) => {
      if (event.origin !== FRAME_ORIGIN || event.data?.kind !== 'probe-registration') return;
      if (priorRuns === 0) record('worker registration survives', true, event.data.existing ? 'already registered' : 'first run here');
      else record('worker registration survives', event.data.existing, event.data.existing ? 'still registered' : 'LOST since the last run');
    }, { once: false });
    addEventListener('message', function on(event) {
      if (event.origin !== FRAME_ORIGIN || event.data?.kind !== 'probe') return;
      removeEventListener('message', on);
      clearTimeout(timer);
      record('frame origin loads in the frame', true);
      record('service worker API present in the frame', event.data.hasApi, event.data.secure ? 'secure context' : 'NOT a secure context');
      record('service worker registers in the frame', event.data.registered, event.data.detail);
      frame.remove();
      resolve();
    });
    document.body.append(frame);
  });
}

async function run(): Promise<void> {
  record(`case: ${CASE}`, true, `${location.origin} framing ${FRAME_ORIGIN}`);
  record('run in this context', true, priorRuns === 0 ? 'first; Pocket-side storage was empty' : `number ${priorRuns + 1}; Pocket-side storage kept from ${Math.round((Date.now() - lastRunAt) / 1000)} s ago`);
  await probe();
  // Both frames carry the sandbox Pocket gives them (`PocketBrowserFrame.tsx`),
  // so the worker, bridge, and shim are measured under production's flags.
  const bootstrap = document.createElement('iframe');
  bootstrap.hidden = true;
  bootstrap.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  bootstrap.src = FRAME_ORIGIN + FRAME_BOOTSTRAP_PATH;
  const { port1, port2 } = new MessageChannel();
  const ready = new Promise<void>((resolve) => {
    port1.onmessage = (event) => { if (event.data?.kind === 'ready') resolve(); };
  });
  bootstrap.onload = () => bootstrap.contentWindow!.postMessage({ kind: 'dormouse-frame-connect' }, FRAME_ORIGIN, [port2]);
  document.body.append(bootstrap);
  try {
    await withTimeout(ready, 20000, 'bootstrap');
    record('bootstrap page connects to this window', true);
  } catch (error) {
    record('bootstrap page connects to this window', false, (error as Error).message);
    return finish();
  }
  serveFrame(fakeFrame, port1);

  const done = new Promise<void>((resolve) => {
    addEventListener('message', (event) => {
      if (event.origin !== FRAME_ORIGIN) return;
      if (event.data?.kind === 'check') record(event.data.name, event.data.ok, event.data.detail);
      if (event.data?.kind === 'stored') recordStored(event.data.name, event.data.previous, event.data.error);
      if (event.data?.kind === 'page-done') resolve();
    });
  });
  const page = document.createElement('iframe');
  page.id = 'page';
  page.setAttribute('sandbox', IFRAME_SANDBOX);
  page.allow = IFRAME_ALLOW;
  page.src = `${FRAME_ORIGIN}/page.html`;
  document.body.append(page);
  try {
    await withTimeout(done, 180000, 'framed page');
  } catch (error) {
    record('framed page finishes', false, (error as Error).message);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  record('cancelling a body reached this window', cancelled);
  finish();
}

function finish(): void {
  const failed = results.filter((result) => !result.ok).length;
  headline.textContent = failed ? `${failed} FAILED, report sent` : 'ALL PASSED, report sent';
  headline.className = failed ? 'fail' : 'pass';
  const again = document.createElement('button');
  again.textContent = 'Reload and run again';
  again.style.cssText = 'font-size:17px;padding:10px;margin:8px 0';
  again.onclick = () => location.reload();
  headline.after(again);
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  void fetch('/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      at: new Date().toISOString(), userAgent: navigator.userAgent, standalone,
      case: CASE, pocketOrigin: location.origin, frameOrigin: FRAME_ORIGIN, failed, results,
    }),
  });
}

void run();
