/**
 * The page a frame origin serves itself, in a hidden frame beside the framed
 * page: it registers the worker and joins it to the Client window. A framed
 * page is same-origin with it and so can reach everything here, which is why
 * the port it holds serves one frame's grant and nothing else
 * (`frame-bridge.ts`).
 */

import { FRAME_WORKER_PATH } from 'remote-lib-common';
import type { BootstrapConnect, BootstrapReady, RelayMessage } from './protocol';

/**
 * Every frame origin sits under one domain, so a page can leave cookies there for
 * its siblings' pages to read and its siblings' requests to carry. This page
 * loads before the frame's own, so that page starts without them, and a cookie
 * of the same name on this origin alone stays, since naming a `Domain` touches
 * only that domain's. A cookie on a deeper path stays too: this page cannot see it.
 */
function dropParentDomainCookies(): void {
  const parent = location.hostname.slice(location.hostname.indexOf('.') + 1);
  for (const cookie of document.cookie.split('; ')) {
    const name = cookie.slice(0, Math.max(cookie.indexOf('='), 0));
    document.cookie = `${name}=; Domain=${parent}; Path=/; Max-Age=0; Secure; SameSite=None`;
  }
}

dropParentDomainCookies();

let connected: MessagePort | null = null;
const ready = navigator.serviceWorker.register(FRAME_WORKER_PATH).then(() => navigator.serviceWorker.ready);

// `frame-ancestors` on this page's response is what makes the parent the
// Client, so its first port is the one this page keeps.
window.addEventListener('message', (event: MessageEvent<BootstrapConnect>) => {
  const port = event.ports[0];
  if (connected || event.source !== window.parent || event.data?.kind !== 'dormouse-frame-connect' || !port) return;
  connected = port;
  void ready.then(() => port.postMessage({ kind: 'ready' } satisfies BootstrapReady));
});

navigator.serviceWorker.addEventListener('message', (event: MessageEvent<RelayMessage>) => {
  const reply = event.ports[0];
  if (!reply) return;
  if (!connected) {
    reply.close();
    return;
  }
  const body = event.data.kind === 'request' ? event.data.body : undefined;
  connected.postMessage(event.data, [reply, ...(body ? [body] : [])]);
});
navigator.serviceWorker.startMessages();
