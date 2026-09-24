import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "dormouse-lib/lib/platform/types";

// Stub the Tauri modules so `./tauri-adapter` imports and constructs outside a
// Tauri webview — same reason as tauri-adapter.test.ts. Nothing here exercises
// the SDK; the stubs just keep module-scope imports (including the transitive
// `tauri-session-store.ts`) from reaching for a Tauri runtime under jsdom.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));

import { BrowserSidecarAdapter } from "./browser-sidecar-adapter";
import { BrowserSidecarHost } from "./browser-sidecar-host";
import { TauriAdapter } from "./tauri-adapter";

// Both adapters are viewed as `PlatformAdapter` here on purpose: `onFilesDropped`
// is optional precisely so consumers can probe for it
// (`platform.onFilesDropped?.(…)` in use-session-persistence.ts), and the probe is
// what these tests stand in for.
describe("BrowserSidecarAdapter capability surface", () => {
  // `onFilesDropped` is documented as present "only on adapters with a native
  // (non-DOM) drag-drop source". This harness is a plain browser tab: a drop there
  // yields `File` objects, never host paths, so there is nothing it could ever
  // report. An implementation that registered handlers and never invoked them
  // would answer the probe "supported" and then stay silent forever.
  it("does not claim native file-drop support", () => {
    const adapter: PlatformAdapter = new BrowserSidecarAdapter(
      new BrowserSidecarHost("http://localhost:1234"),
    );
    expect(adapter.onFilesDropped).toBeUndefined();
  });

  // The contrast that makes the assertion above meaningful: the Tauri host does
  // have a native drag-drop source, so it does implement the member.
  it("is the exception — TauriAdapter still implements it", () => {
    const adapter: PlatformAdapter = new TauriAdapter();
    expect(typeof adapter.onFilesDropped).toBe("function");
  });
});

// The harness mirrors the shipped persistence answer, so a reload there
// exercises what the app does (docs/specs/transport.md -> "The governing rule").
describe("BrowserSidecarAdapter session persistence", () => {
  const KEY = "dormouse.browser-sidecar.session";
  const session = { version: 3 as const, panes: [{ id: "pane-a", title: "A", cwd: "/a", untouched: false }] };
  const windowBlob = {
    version: 1 as const,
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

  it("wraps a pre-Window blob rather than dropping it", () => {
    localStorage.setItem(KEY, JSON.stringify(session));
    const adapter = new BrowserSidecarAdapter(new BrowserSidecarHost("http://localhost:1234"));
    expect(adapter.getWindowState()?.workspaces.map((ws) => ws.session)).toEqual([session]);
    localStorage.removeItem(KEY);
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
