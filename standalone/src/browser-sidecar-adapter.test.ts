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

// The harness must not persist Session state that production standalone drops.
// `TauriAdapter` gates `saveState`/`getState` behind `PERSIST_SESSION` and reports
// `persistsSession: false` (docs/specs/standalone.md -> "Standalone persists no
// Session state"). A harness that writes `localStorage` instead exercises the whole
// save/restore path — record build, `getCwd` round trip per pane, restore on reload —
// that the real app never runs, and the blob outlives the run in the dev browser
// profile even though the harness gives every run its own temp state dir.
describe("BrowserSidecarAdapter session persistence", () => {
  const KEY = "dormouse.browser-sidecar.session";

  it("reports the same persistsSession as TauriAdapter", () => {
    const harness: PlatformAdapter = new BrowserSidecarAdapter(
      new BrowserSidecarHost("http://localhost:1234"),
    );
    const tauri: PlatformAdapter = new TauriAdapter();
    expect(harness.persistsSession).toBe(tauri.persistsSession);
    expect(harness.persistsSession).toBe(false);
  });

  it("does not write session state to localStorage", () => {
    localStorage.removeItem(KEY);
    const adapter: PlatformAdapter = new BrowserSidecarAdapter(
      new BrowserSidecarHost("http://localhost:1234"),
    );
    adapter.saveState({ version: 3, panes: [], lathLayout: null });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("does not restore a stale blob left by an earlier run", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 3, panes: [], lathLayout: null }));
    const adapter: PlatformAdapter = new BrowserSidecarAdapter(
      new BrowserSidecarHost("http://localhost:1234"),
    );
    expect(adapter.getState()).toBeNull();
    localStorage.removeItem(KEY);
  });

  // Ignoring the key is not enough: snapshots carry transcripts, and localStorage is
  // keyed by browser profile rather than by the harness's per-run temp state dir, so a
  // blob written before this gate existed would sit in the developer's profile forever.
  it("deletes a pre-gate blob on init", async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 3, panes: [], lathLayout: null }));
    const host = new BrowserSidecarHost("http://localhost:1234");
    vi.spyOn(host, "init").mockResolvedValue(undefined);
    vi.spyOn(host, "onEvent").mockReturnValue(() => {});
    // `init()` also runs `installConsoleForwarder()`, which replaces
    // `console.log/warn/error` on the shared jsdom window with versions that POST to
    // the dev host, and marks itself done with a flag nothing ever clears. Every
    // later `console.*` in this file would inherit that. Claim the flag first so the
    // forwarder no-ops and the test stays scoped to `clearPersistedState`.
    (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean })
      .__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;
    const adapter = new BrowserSidecarAdapter(host);
    await adapter.init();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
