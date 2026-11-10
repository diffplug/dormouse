/**
 * A frame origin's service worker: every same-origin request a framed page
 * makes becomes a {@link RelayRequest} to the bootstrap page, and so to the
 * Client window holding the session. Stateless, since a worker is stopped and
 * restarted at will: it finds the bootstrap page again for each request.
 */

import { FRAME_BOOTSTRAP_PATH, isFrameAssetPath, normalizeOrigin } from 'remote-lib-common';
import { WORKER_ALIVE_MS, type RelayMessage, type RelayRequest, type ResponseControl, type ResponseMessage } from './protocol';

/** Past the proxy's own upstream timeout, so its error page gets there first. */
const HEAD_TIMEOUT_MS = 65_000;
/** Statuses whose `Response` must have no body. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

interface WorkerClient {
  url: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface FrameWorkerScope {
  location: { origin: string };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: true }): Promise<readonly WorkerClient[]>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: never) => void): void;
}

interface FetchLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
  /** Keeps the worker running, which a streaming response alone need not. */
  waitUntil?(promise: Promise<unknown>): void;
}

interface ExtendableLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface MessageLike {
  data: unknown;
  ports: readonly MessagePort[];
  waitUntil?(promise: Promise<unknown>): void;
}

export function installFrameWorker(scope: FrameWorkerScope): void {
  scope.addEventListener('install', (event: ExtendableLike) => event.waitUntil(scope.skipWaiting()));
  scope.addEventListener('activate', (event: ExtendableLike) => event.waitUntil(scope.clients.claim()));
  scope.addEventListener('fetch', (event: FetchLike) => {
    const url = new URL(event.request.url);
    // Anything else is the network's: the page's own absolute URLs, and this
    // origin's assets, which is how the bootstrap page loads at all.
    if (url.origin !== scope.location.origin || isFrameAssetPath(url.pathname)) return;
    let finished = () => {};
    event.waitUntil?.(new Promise<void>((resolve) => { finished = resolve; }));
    event.respondWith(relay(scope, event.request, `${url.pathname}${url.search}`, finished).catch((error: unknown) => {
      finished();
      throw error;
    }));
  });
  // The WebSocket shim, which a worker cannot intercept: a page's socket
  // arrives as a message with its port, and goes the way a request does.
  scope.addEventListener('message', (event: MessageLike) => {
    const data = event.data as Partial<RelayMessage> | null;
    const port = event.ports[0];
    if (data?.kind !== 'socket' || !port) return;
    const sent = bootstrapOf(scope).then((bootstrap) => {
      if (bootstrap) bootstrap.postMessage(data, [port]);
      else port.postMessage({ kind: 'closed', code: 1006, reason: 'no connection' });
    });
    event.waitUntil?.(sent);
  });
}

async function bootstrapOf(scope: FrameWorkerScope): Promise<WorkerClient | undefined> {
  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.find((client) => new URL(client.url).pathname === FRAME_BOOTSTRAP_PATH);
}

/**
 * Why this request may not go to the page, or `null`. A worker sees no
 * `Origin`, so it stands in for the browser's: what a frame's own document
 * sends is same-origin, and a frame is never a top-level page. A form another
 * site aims at this origin is refused here rather than reaching the page
 * unlabelled.
 */
export function refusal(request: Pick<Request, 'mode' | 'method' | 'destination' | 'referrer'>, origin: string): string | null {
  if (request.mode !== 'navigate') return null;
  if (request.destination === 'document') return 'A frame only loads inside Dormouse.';
  const safe = request.method === 'GET' || request.method === 'HEAD';
  // No referrer is a page's own policy, and `relayHeaders` vouches for nothing then.
  return safe || !request.referrer || normalizeOrigin(request.referrer) === origin
    ? null : 'A form from another site cannot reach this page.';
}

/** The fields the browser adds past the worker, in the terms the Burrow expects them. */
export function relayHeaders(request: Pick<Request, 'headers' | 'method' | 'mode' | 'referrer'>, origin: string): [string, string][] {
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  // `refusal` has already turned away a foreign write, so a write here is the
  // frame's own document, unless it is a form with no referrer to say so, which
  // goes as a browser sends any such form.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const unvouched = request.mode === 'navigate' && normalizeOrigin(request.referrer) !== origin;
    headers.push(['origin', unvouched ? 'null' : origin]);
  }
  if (request.referrer && request.referrer !== 'about:client') headers.push(['referer', request.referrer]);
  return headers;
}

function failure(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

async function relay(scope: FrameWorkerScope, request: Request, path: string, finished: () => void): Promise<Response> {
  const origin = scope.location.origin;
  const answer = (status: number, text: string) => {
    finished();
    return failure(status, text);
  };
  const refused = refusal(request, origin);
  if (refused) return answer(403, refused);
  const bootstrap = await bootstrapOf(scope);
  if (!bootstrap) return answer(503, 'The connection to your computer is gone.');
  const message: RelayRequest = {
    kind: 'request',
    method: request.method,
    path,
    headers: relayHeaders(request, origin),
    destination: request.destination,
  };
  const transfer: Transferable[] = [];
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    message.body = await request.arrayBuffer();
    transfer.push(message.body);
  }
  // Past here `responseFrom` hears of an abort; before, only this can.
  if (request.signal.aborted) return answer(503, 'The page gave up on this request.');
  const { port1, port2 } = new MessageChannel();
  bootstrap.postMessage(message, [port2, ...transfer]);
  return responseFrom(port1, finished, request.signal);
}

/** The {@link ResponseMessage}s on `port` as a `Response`, pulling one chunk per read. */
export function responseFrom(port: MessagePort, finished: () => void, abandoned?: AbortSignal): Promise<Response> {
  return new Promise((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let wake: (() => void) | null = null;
    let alive: ReturnType<typeof setInterval> | undefined;
    const send = (control: ResponseControl) => port.postMessage(control);
    const close = () => {
      clearTimeout(timer);
      clearInterval(alive);
      port.close();
      finished();
    };
    const cancel = () => {
      send({ kind: 'cancel' });
      close();
    };
    const timer = setTimeout(() => {
      // Told, so a request still waiting its turn does not run after this answer.
      cancel();
      resolve(failure(504, 'Your computer did not answer in time.'));
    }, HEAD_TIMEOUT_MS);
    // A page's own abort, which must stop a request still waiting its turn too,
    // and answer the fetch event, whose head timer `cancel` clears; after the
    // head the answer is a no-op.
    abandoned?.addEventListener('abort', () => {
      cancel();
      resolve(failure(503, 'The page gave up on this request.'));
    }, { once: true });
    const settlePull = () => {
      wake?.();
      wake = null;
    };

    const responseOf = (head: Extract<ResponseMessage, { kind: 'head' }>): Response => {
      // A status `Response` refuses: an upstream's nonsense must not throw here.
      if (head.status < 200 || head.status > 599) {
        cancel();
        return failure(502, `The page answered with status ${head.status}.`);
      }
      const headers = new Headers();
      for (const [name, value] of head.headers) {
        try {
          headers.append(name, value);
        } catch {
          // A field the browser will not hold; the page goes without it.
        }
      }
      if (NULL_BODY_STATUS.has(head.status)) {
        cancel();
        return new Response(null, { status: head.status, statusText: head.statusText, headers });
      }
      alive = setInterval(() => send({ kind: 'alive' }), WORKER_ALIVE_MS);
      const body = new ReadableStream<Uint8Array>({
        start: (c) => { controller = c; },
        pull: () => new Promise<void>((done) => {
          wake = done;
          send({ kind: 'pull' });
        }),
        cancel,
      }, { highWaterMark: 0 });
      return new Response(body, { status: head.status, statusText: head.statusText, headers });
    };

    port.onmessage = (event: MessageEvent<ResponseMessage>) => {
      const message = event.data;
      switch (message.kind) {
        case 'head':
          clearTimeout(timer);
          resolve(responseOf(message));
          return;
        case 'chunk':
          controller?.enqueue(message.bytes);
          settlePull();
          return;
        case 'end':
          controller?.close();
          settlePull();
          close();
          return;
        case 'error':
          clearTimeout(timer);
          if (controller) controller.error(new Error(message.message));
          else resolve(failure(502, message.message));
          settlePull();
          close();
          return;
      }
    };
  });
}
