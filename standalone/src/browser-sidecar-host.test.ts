import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSidecarHost } from "./browser-sidecar-host";

// The dev bridge is an authenticated loopback control plane — `pty_spawn`
// reaches it with caller-supplied shell/args/env. `url()` is the single place
// that attaches the credential, so these guard that choke point rather than
// each call site.
describe("BrowserSidecarHost.url", () => {
  const BASE = "http://127.0.0.1:1422/?t=deadbeef";

  it("carries the base URL's token onto every endpoint, the SSE stream included", () => {
    const host = new BrowserSidecarHost(BASE);
    for (const path of [
      "/__dormouse_dev_host/events",
      "/__dormouse_dev_host/send",
      "/__dormouse_dev_host/invoke",
      "/__dormouse_dev_host/console",
    ]) {
      const url = host.url(path);
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("t")).toBe("deadbeef");
    }
  });

  it("stays clean when the base carries no token", () => {
    const url = new BrowserSidecarHost("http://127.0.0.1:1422").url("/__dormouse_dev_host/send");
    expect(url.searchParams.has("t")).toBe(false);
    expect(url.pathname).toBe("/__dormouse_dev_host/send");
  });
});

// jsdom ships no `EventSource`; this one is driven by hand. `EventTarget`
// gives it the `addEventListener` surface the host subscribes through.
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  constructor(readonly url: string | URL) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  fail(fatal = false): void { this.readyState = fatal ? FakeEventSource.CLOSED : 0; this.dispatchEvent(new Event("error")); }
}

// The bridge only fans a broadcast out to streams it has already registered,
// and the app POSTs its two alert seeds the moment `init()` resolves — replies
// that ride the stream. So `init()` settles on the stream being *open*, never
// on the `EventSource` merely existing (docs/specs/transport.md ->
// "Standalone browser-dev harness").
describe("BrowserSidecarHost.init", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const stream = () => FakeEventSource.instances[0]!;
  async function settled(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
    let state: "pending" | "resolved" | "rejected" = "pending";
    promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
    await Promise.resolve();
    await Promise.resolve();
    return state;
  }

  it("resolves on the stream's open event, not on construction", async () => {
    const host = new BrowserSidecarHost("http://127.0.0.1:1422/?t=deadbeef");
    const ready = host.init();
    expect(await settled(ready)).toBe("pending");
    stream().open();
    expect(await settled(ready)).toBe("resolved");
    // A second call while connected is the same connection, not a second stream.
    await host.init();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("rejects, and stops the stream, when it errors before opening", async () => {
    const host = new BrowserSidecarHost("http://127.0.0.1:1422/?t=deadbeef");
    const ready = host.init();
    stream().fail(true);
    await expect(ready).rejects.toThrow("failed before it opened");
    expect(stream().closed).toBe(true);
  });

  it("allows retryable pre-open failures to reconnect within the deadline", async () => {
    const host = new BrowserSidecarHost("http://127.0.0.1:1422");
    const ready = host.init();
    stream().fail();
    expect(await settled(ready)).toBe("pending");
    expect(stream().closed).toBe(false);
    stream().open();
    await expect(ready).resolves.toBeUndefined();
  });

  it("gives up after a bounded wait when neither event arrives", async () => {
    vi.useFakeTimers();
    const host = new BrowserSidecarHost("http://127.0.0.1:1422/?t=deadbeef");
    const ready = host.init();
    vi.advanceTimersByTime(BrowserSidecarHost.OPEN_TIMEOUT_MS);
    await expect(ready).rejects.toThrow("did not open");
    expect(stream().closed).toBe(true);
  });

  // The browser re-establishes a dropped stream by itself, but the bridge's
  // fan-out set forgot this client in between: whatever it broadcast is gone.
  // The reconnect hook is how subscribers learn to re-ask; the first open is
  // not a reconnect, `init()` already reports that one.
  it("reports every open after the first as a reconnect", async () => {
    const host = new BrowserSidecarHost("http://127.0.0.1:1422/?t=deadbeef");
    const reconnects = vi.fn();
    host.onReconnect(reconnects);
    const ready = host.init();
    stream().open();
    await ready;
    expect(reconnects).not.toHaveBeenCalled();
    stream().fail();
    expect(await settled(ready)).toBe("resolved");
    expect(reconnects).not.toHaveBeenCalled();
    stream().open();
    expect(reconnects).toHaveBeenCalledTimes(1);
  });
});
