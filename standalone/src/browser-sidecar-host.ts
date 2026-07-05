export type BrowserSidecarEvent = { event: string; data: unknown };

export class BrowserSidecarHost {
  private events: EventSource | null = null;
  private readonly eventHandlers = new Set<(event: BrowserSidecarEvent) => void>();
  private nextId = 1;

  constructor(private readonly baseUrl: string) {}

  url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  async init(): Promise<void> {
    if (this.events) return;
    const url = this.url('/__dormouse_dev_host/events');
    this.events = new EventSource(url);
    this.events.addEventListener('sidecar', (event) => {
      const parsed = JSON.parse((event as MessageEvent).data) as BrowserSidecarEvent;
      this.deliver(parsed);
    });
    this.events.onerror = () => {
      console.error('[browser-sidecar] event stream disconnected');
    };
  }

  close(): void {
    this.events?.close();
    this.events = null;
  }

  onEvent(handler: (event: BrowserSidecarEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
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
