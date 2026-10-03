// The desktop playground's viewer relay (docs/specs/tutorial.md -> Playground
// filesystem). Stateless, since an idle worker is stopped: viewer assets come
// from the static build, every other request goes to the playground windows,
// and the window that owns the URL's token answers it.
const SCOPE = '/playground-fs/';
const ASSETS = '/builtin-viewer/';
const TIMEOUT_MS = 5000;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  const match = /^([0-9a-f-]{36})\/(.*)$/.exec(url.pathname.slice(SCOPE.length));
  if (!match) return; // the worker script itself, or nothing
  const [, token, route] = match;
  const asset = /^assets\/([\w.-]+)$/.exec(route);
  event.respondWith(asset ? fetch(ASSETS + asset[1]) : relay(event.request, token, route, url.search));
});

async function relay(request, token, rawRoute, search) {
  let route;
  try { route = decodeURIComponent(rawRoute); } catch { return new Response('', { status: 400 }); }
  const [body, windows] = await Promise.all([
    request.method === 'POST' ? request.text() : '',
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
  ]);
  const message = { type: 'playground-fs-request', token, method: request.method, route, search, body };
  const channels = [];
  const asks = windows.filter((client) => client.frameType === 'top-level').map((client) => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channels.push(channel);
    channel.port1.onmessage = ({ data }) => (data ? resolve(data) : reject());
    client.postMessage(message, [channel.port2]);
  }));
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(reject, TIMEOUT_MS); });
  try {
    const { status, headers, body: answer } = await Promise.race([Promise.any(asks), timeout]);
    return new Response(answer, { status, headers });
  } catch {
    return new Response('This viewer has closed.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } finally {
    clearTimeout(timer);
    // A window that holds no viewer, or no playground at all, never answers.
    for (const channel of channels) channel.port1.close();
  }
}
