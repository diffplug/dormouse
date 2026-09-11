import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter, PtyDataDetail } from "dormouse-lib/lib/platform/types";

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
import type { AlertManager } from "dormouse-lib/lib/alert-manager";
import type { AlertSettings } from "dormouse-lib/lib/alert-settings";
import { DEFAULT_ALERT_SETTINGS } from "dormouse-lib/lib/alert-settings-model";

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
    workspaces: [{ id: "ws-1", name: "One", session }],
    activeWorkspaceId: "ws-1",
  };

  it("reports the same persistsSession as TauriAdapter", () => {
    const harness: PlatformAdapter = new BrowserSidecarAdapter(
      new BrowserSidecarHost("http://localhost:1234"),
    );
    const tauri: PlatformAdapter = new TauriAdapter();
    expect(harness.persistsSession).toBe(tauri.persistsSession);
    expect(harness.persistsSession).toBe(true);
  });

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

// The harness rides the same sidecar, so the parse boundary is the same one
// TauriAdapter has: forward the pair, apply the events, push the theme.
describe("BrowserSidecarAdapter terminal stream", () => {
  async function listening() {
    const host = new BrowserSidecarHost("http://localhost:1234");
    let emit: (event: { event: string; data: unknown }) => void = () => {};
    let reconnect: () => void = () => {};
    vi.spyOn(host, "init").mockResolvedValue(undefined);
    vi.spyOn(host, "onEvent").mockImplementation((listener) => {
      emit = listener;
      return () => {};
    });
    vi.spyOn(host, "onReconnect").mockImplementation((listener) => {
      reconnect = listener;
      return () => {};
    });
    const send = vi.spyOn(host, "send").mockImplementation(() => {});
    (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean })
      .__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;

    const adapter = new BrowserSidecarAdapter(host);
    await adapter.init();
    send.mockClear();
    // The manager is where a broadcast has to land for the rule to bite; the
    // handler fan-out alone would pass with a private copy of the store.
    const manager = (adapter as unknown as { alertManager: AlertManager }).alertManager;
    const alertCommands = () =>
      send.mock.calls.filter(([cmd]) => cmd === "alert_command").map(([, args]) => args);
    return {
      adapter, send, manager, alertCommands,
      reconnect: () => reconnect(),
      deliver: (event: string, data: unknown) => emit({ event, data }),
    };
  }

  it("forwards the projection pair it was handed, parsing nothing again", async () => {
    const { adapter, send, deliver } = await listening();
    const seen: PtyDataDetail[] = [];
    adapter.onPtyData((detail) => void seen.push(detail));

    deliver("pty:data", { id: "b1", data: "\x1b]11;?\x07tail", textData: "tail" });

    expect(seen).toEqual([{ id: "b1", data: "\x1b]11;?\x07tail", textData: "tail" }]);
    expect(send.mock.calls.filter(([cmd]) => cmd === "pty_write")).toEqual([]);
  });

  it("routes the alert stores through the sidecar and applies their broadcasts", async () => {
    const { adapter, manager, alertCommands, deliver } = await listening();
    const quiet: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false };
    adapter.alertSetCommandWatched("cargo", true);
    adapter.alertPublishSettings(quiet, { seed: true });
    expect(alertCommands()).toEqual([
      { payload: { op: "setCommandWatched", name: "cargo", watched: true } },
      { payload: { op: "initializeSettings", settings: quiet } },
    ]);

    const setWatched = vi.spyOn(manager, "setWatchedCommands");
    const applySettings = vi.spyOn(manager, "applySettings");
    const names: string[][] = [];
    const settings: AlertSettings[] = [];
    adapter.onWatchedCommands((next) => void names.push(next));
    adapter.onAlertSettings((next) => void settings.push(next));

    deliver("alert:watchedCommands", { names: ["cargo", "make"] });
    expect(setWatched).toHaveBeenCalledWith(["cargo", "make"]);
    expect(names).toEqual([["cargo", "make"]]);

    const canonical: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, deferAlertsUntilQuiet: true };
    deliver("alert:settings", { settings: canonical });
    expect(applySettings).toHaveBeenCalledWith(canonical);
    expect(settings).toEqual([canonical]);

    // A broadcast with no blob is dropped, not applied as "no settings".
    deliver("alert:settings", {});
    expect(applySettings).toHaveBeenCalledTimes(1);
    expect(settings).toEqual([canonical]);
  });

  // The stream is the only path a store's snapshot takes back, and a dropped
  // stream loses the bridge's fan-out entry with it. Re-offering the seeds is
  // what makes the sidecar republish; a repeat seed is refused as a seed but
  // still answered (lib/src/lib/watched-command-host.ts `initialize`).
  it("re-sends its last seeds when the event stream reconnects", async () => {
    const { adapter, alertCommands, reconnect, send } = await listening();
    const quiet: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false };
    adapter.alertSetWatchedCommands(["cargo"]);
    adapter.alertPublishSettings(quiet, { seed: true });
    // Neither a mutation nor a non-seed publish is a seed; neither is replayed.
    adapter.alertSetCommandWatched("make", true);
    adapter.alertPublishSettings({ ...quiet, pushEnabled: true }, { seed: false });
    send.mockClear();

    reconnect();
    expect(alertCommands()).toEqual([
      { payload: { op: "initializeWatchedCommands", names: ["cargo"] } },
      { payload: { op: "initializeSettings", settings: quiet } },
    ]);
  });

  it("pushes the resolved theme so the sidecar can answer a colour query", async () => {
    const { adapter, send } = await listening();
    adapter.requestInit();

    const pushed = send.mock.calls.filter(([cmd]) => cmd === "pty_theme_colors");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]![1]).toEqual({
      colors: {
        foreground: expect.any(String),
        background: expect.any(String),
        cursor: expect.any(String),
      },
    });
  });
});
