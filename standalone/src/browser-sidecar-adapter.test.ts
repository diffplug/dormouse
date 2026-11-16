import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";
import { BrowserSidecarAdapter } from "./browser-sidecar-adapter";
import { BrowserSidecarHost } from "./browser-sidecar-host";

// The harness mirrors the shipped persistence answer, so a reload there
// exercises what the app does (docs/specs/transport.md -> "The governing rule").
describe("BrowserSidecarAdapter session persistence", () => {
  const KEY = "dormouse.browser-sidecar.session";
  const session = { version: 4 as const, panes: [{ id: "pane-a", title: "A", cwd: "/a", untouched: false }] };
  const windowBlob = {
    version: 2 as const,
    workspaces: [{ id: "ws-1", name: "One", nameIsAuto: false, session }],
    activeWorkspaceId: "ws-1",
  };

  it("round-trips a Window through localStorage", () => {
    localStorage.removeItem(KEY);
    const adapter = new BrowserSidecarAdapter(new BrowserSidecarHost("http://localhost:1234"));
    adapter.saveWindowState(windowBlob);
    expect(adapter.getWindowState()).toEqual(windowBlob);
    // The shared `getState` readers want a bare Session and the blob is a Window,
    // so it answers nothing; the boot reads `getWindowState`.
    expect((adapter as PlatformAdapter).getState()).toBeNull();
    localStorage.removeItem(KEY);
  });

  it.each([
    ["a bare Session", { ...session, version: 3 }],
    ["a Window", { ...windowBlob, version: 1 }],
  ])("starts fresh on %s an older build left in localStorage", (_kind, blob) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    localStorage.setItem(KEY, JSON.stringify(blob));
    const adapter = new BrowserSidecarAdapter(new BrowserSidecarHost("http://localhost:1234"));
    expect(adapter.getWindowState()).toBeNull();
    localStorage.removeItem(KEY);
    info.mockRestore();
  });

  it("claims the recovery commands for its saved panes during init", async () => {
    localStorage.setItem(KEY, JSON.stringify(windowBlob));
    const host = new BrowserSidecarHost("http://localhost:1234");
    vi.spyOn(host, "init").mockResolvedValue(undefined);
    vi.spyOn(host, "onEvent").mockReturnValue(() => {});
    const invoke = vi.spyOn(host, "invoke").mockResolvedValue({ "pane-a": "claude --continue" });
    // Claim the console-forwarder flag so init() doesn't patch console.* on the
    // shared jsdom window for every later test in this file.
    (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean })
      .__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;

    const adapter = new BrowserSidecarAdapter(host);
    await adapter.init();
    await adapter.recoveryReady;

    expect(invoke).toHaveBeenCalledWith("take_recovery_commands", { paneIds: ["pane-a"] });
    expect(adapter.getRecoveryCommands()).toEqual({ "pane-a": "claude --continue" });
    localStorage.removeItem(KEY);
  });
});

describe("BrowserSidecarAdapter browser requests", () => {
  it("forwards every request through one browser_request, and answers a failure as a result", async () => {
    const host = new BrowserSidecarHost("http://localhost:1234");
    const invoke = vi.spyOn(host, "invoke").mockResolvedValueOnce({ ok: true, url: "ws://127.0.0.1:9/view/abc" });
    const adapter = new BrowserSidecarAdapter(host);
    const request = { provider: "agent-browser" as const, binding: { session: "sess" }, op: "view" as const, stream: 4321 };

    expect(await adapter.browser(request)).toEqual({ ok: true, url: "ws://127.0.0.1:9/view/abc" });
    expect(invoke).toHaveBeenCalledWith("browser_request", { request });

    invoke.mockRejectedValueOnce(new Error("bridge down"));
    expect(await adapter.browser({ provider: "agent-browser", binding: { session: "sess" }, op: "close" })).toEqual({ ok: false, error: "bridge down" });
  });
});

// The parse boundary and the alert transport both sidecar adapters share are
// pinned once, for both, in `sidecar-adapters.test.ts`.
describe("BrowserSidecarAdapter event stream", () => {
  // The SSE stream is the only path the alerts' events take here, and whatever
  // the sidecar sent while it was down is gone: `sync` has the sidecar re-send
  // this window's state and both stores, ending nothing.
  it("asks the sidecar to sync when the event stream reconnects", async () => {
    const host = new BrowserSidecarHost("http://localhost:1234");
    let reconnect: () => void = () => {};
    vi.spyOn(host, "init").mockResolvedValue(undefined);
    vi.spyOn(host, "invoke").mockResolvedValue(undefined);
    vi.spyOn(host, "onEvent").mockReturnValue(() => {});
    vi.spyOn(host, "onReconnect").mockImplementation((listener) => {
      reconnect = listener;
      return () => {};
    });
    const send = vi.spyOn(host, "send").mockImplementation(() => {});
    (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean })
      .__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;
    await new BrowserSidecarAdapter(host).init();
    send.mockClear();

    reconnect();
    expect(send.mock.calls).toEqual([["alert_command", { payload: { op: "sync", ids: [] } }]]);
  });
});
