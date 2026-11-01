/**
 * The page a frame origin serves itself, in a hidden frame beside the framed
 * page: it registers the worker and joins it to the Client window. A framed
 * page is same-origin with it and so can reach everything here, which is why
 * the port it holds serves one frame's grant and nothing else
 * (`frame-bridge.ts`).
 */

import { FRAME_WORKER_PATH, type BootstrapConnect, type BootstrapReady, type RelayMessage } from './protocol';

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
