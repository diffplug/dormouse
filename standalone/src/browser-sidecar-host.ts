export type BrowserSidecarEvent = { event: string; data: unknown };

export class BrowserSidecarHost {
  /** How long `init()` waits for the stream to open before giving up. */
  static readonly OPEN_TIMEOUT_MS = 10_000;

  private events: EventSource | null = null;
  private ready: Promise<void> | null = null;
  private readonly eventHandlers = new Set<(event: BrowserSidecarEvent) => void>();
  private readonly reconnectHandlers = new Set<() => void>();
  private nextId = 1;

  constructor(private readonly baseUrl: string) {}

  /**
   * The one place that knows the bridge is authenticated. Every caller — the
   * three methods below and the console mirror in `browser-sidecar-adapter` —
   * builds its URL here, so the credential cannot be forgotten at a call site.
   *
   * The harness bakes its bridge token into the base URL's query
   * (`http://127.0.0.1:1422/?t=…`), so setting the path on a copy of the base
   * carries it along; resolving `path` *against* the base would drop it. It
   * travels as a query param rather than an `Authorization` header because
   * `EventSource` cannot set headers, and `/events` is gated like the rest.
   */
  url(path: string): URL {
    const url = new URL(this.baseUrl);
    url.pathname = path;
    return url;
  }

  /**
   * Resolves once the SSE stream is *open*, not once the `EventSource` is
   * constructed. The bridge registers a stream in `sseClients` when the GET
   * arrives, and the app's first act after `init()` is to POST the two alert
   * seeds whose replies come back only over that stream — a POST that beat
   * the GET would be answered to nobody (docs/specs/transport.md ->
   * "Standalone browser-dev harness"). Tauri awaits its listener
   * registration for the same reason.
   */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    const url = this.url('/__dormouse_dev_host/events');
    const events = new EventSource(url);
    this.events = events;
    events.addEventListener('sidecar', (event) => {
      const parsed = JSON.parse((event as MessageEvent).data) as BrowserSidecarEvent;
      this.deliver(parsed);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      let opened = false;
      const giveUp = (why: string) => {
        clearTimeout(timer);
        events.close();
        reject(new Error(`[browser-sidecar] event stream ${why}`));
      };
      const timer = setTimeout(
        () => giveUp(`did not open within ${BrowserSidecarHost.OPEN_TIMEOUT_MS}ms`),
        BrowserSidecarHost.OPEN_TIMEOUT_MS,
      );
      events.addEventListener('open', () => {
        if (!opened) {
          opened = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        // The browser reconnected on its own after a drop. The bridge's
        // fan-out set forgot this client in between, so anything it would
        // have broadcast is gone; subscribers re-ask for what they need.
        for (const handler of this.reconnectHandlers) handler();
      });
      events.addEventListener('error', () => {
        if (!opened) {
          giveUp('failed before it opened');
          return;
        }
        console.error('[browser-sidecar] event stream disconnected');
      });
    });
    return this.ready;
  }

  close(): void {
    this.events?.close();
    this.events = null;
    this.ready = null;
  }

  onEvent(handler: (event: BrowserSidecarEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Fires on every `open` after the first — the stream was dropped and the
   *  browser re-established it. Not on the initial open; `init()` covers that. */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  send(cmd: string, args?: Record<string, unknown>): void {
    fetch(this.url('/__dormouse_dev_host/send'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    }).catch((err) => console.error(`[browser-sidecar] ${cmd} failed:`, err));
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const requestId = `browser-${this.nextId++}`;
    const response = await fetch(this.url('/__dormouse_dev_host/invoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, cmd, args: args ?? {} }),
    });
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json() as { ok: boolean; result?: T; error?: string };
    if (!body.ok) throw new Error(body.error ?? `${cmd} failed`);
    return body.result as T;
  }

  // Request/response correlation happens over the /invoke HTTP round-trip,
  // not the SSE stream — every streamed event just fans out to handlers.
  private deliver(event: BrowserSidecarEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }
}
