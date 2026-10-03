import { VIEWER_SCOPE, type PlaygroundViewers, type ViewerRequest } from "./viewers";

interface RelayMessage extends ViewerRequest {
  type: "playground-fs-request";
  token: string;
}

/**
 * Registers the `/playground-fs/` service worker (`public/playground-fs/sw.js`)
 * and answers its requests for `viewers`' tokens. Resolves once the worker is
 * active, so a viewer announced after it can be framed; rejects where the
 * browser has no service worker (a plain-http LAN origin, some private modes).
 */
export async function connectViewerRelay(viewers: PlaygroundViewers): Promise<() => void> {
  const container = navigator.serviceWorker;
  if (!container) throw new Error("this browser has no service worker, which the playground's viewers need");
  const onMessage = (event: MessageEvent) => {
    const data = event.data as RelayMessage | undefined;
    const port = event.ports[0];
    if (data?.type !== "playground-fs-request" || !port) return;
    port.postMessage(viewers.handle(data.token, data));
  };
  container.addEventListener("message", onMessage);
  // The page is outside the worker's scope, so it is never controlled and
  // `ready` never settles; messages wait for this call instead.
  container.startMessages();
  const registration = await container.register(`${VIEWER_SCOPE}sw.js`, { scope: VIEWER_SCOPE });
  await activated(registration);
  return () => container.removeEventListener("message", onMessage);
}

function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return Promise.reject(new Error("the playground's service worker did not install"));
  if (worker.state === "activated") return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      else if (worker.state === "redundant") reject(new Error("the playground's service worker failed to start"));
    });
  });
}
