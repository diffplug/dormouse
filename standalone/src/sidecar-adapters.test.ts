import { getToolDirty, resetToolDirty } from "dormouse-lib/lib/tool-dirty-store";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the Tauri modules so both adapters import and construct outside a Tauri
// webview; the Tauri harness below drives the two mocks.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));
/** The webview's baked mode, read as each adapter is built. */
const build = vi.hoisted(() => ({ mode: "hosted" as "hosted" | "self-host" }));
vi.mock("dormouse-lib/host/relay-origin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dormouse-lib/host/relay-origin")>()),
  bakedRelayMode: () => build.mode,
}));

import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ALERT_EVENTS } from "dormouse-lib/host/alert-protocol";
import type { AlertStateDetail, PlatformAdapter, PtyDataDetail } from "dormouse-lib/lib/platform/types";
import { getTerminalPaneState } from "dormouse-lib/lib/terminal-state-store";
import { BrowserSidecarAdapter } from "./browser-sidecar-adapter";
import { BrowserSidecarHost } from "./browser-sidecar-host";
import { TauriAdapter } from "./tauri-adapter";

/**
 * The two adapters over standalone's sidecar — the Tauri webview's and the
 * browser harness's — differ only in their transport, so the parse boundary
 * and the alert transport are pinned once, for both: forward the pair, apply
 * the events, carry every alert verb as one `alert_command`, and hand the
 * sidecar's events to the shared client (`lib/src/host/alert-client.test.ts`
 * covers what each verb sends).
 */

interface Harness {
  adapter: PlatformAdapter;
  /** One sidecar event, as this adapter's transport delivers it. */
  deliver(event: string, payload: unknown): void;
  /** Every `[command, args]` sent since init. */
  sent(): Array<[string, unknown]>;
  /** Whether the adapter was listening for `event` when it said hello. */
  listeningAtHello(event: string): boolean;
}

async function tauri(): Promise<Harness> {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const heardAtHello = new Set<string>();
  vi.mocked(listen).mockImplementation((async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => {};
  }) as unknown as typeof listen);
  const invoke = vi.mocked(rawInvoke);
  invoke.mockClear();
  invoke.mockImplementation((async (cmd: string, args?: { payload?: { op?: string } }) => {
    if (cmd === "alert_command" && args?.payload?.op === "hello") for (const event of handlers.keys()) heardAtHello.add(event);
    return undefined;
  }) as unknown as typeof rawInvoke);
  const adapter = new TauriAdapter();
  await adapter.init();
  const since = invoke.mock.calls.length;
  return {
    adapter,
    deliver: (event, payload) => void handlers.get(event)?.({ payload }),
    sent: () => invoke.mock.calls.slice(since).map(([cmd, args]) => [cmd, args]),
    listeningAtHello: (event) => heardAtHello.has(event),
  };
}

async function browser(): Promise<Harness> {
  const host = new BrowserSidecarHost("http://localhost:1234");
  let emit: ((event: { event: string; data: unknown }) => void) | null = null;
  let listeningAtHello = false;
  vi.spyOn(host, "init").mockResolvedValue(undefined);
  vi.spyOn(host, "invoke").mockResolvedValue(undefined);
  vi.spyOn(host, "onReconnect").mockReturnValue(() => {});
  vi.spyOn(host, "onEvent").mockImplementation((listener) => {
    emit = listener;
    return () => {};
  });
  const send = vi.spyOn(host, "send").mockImplementation((cmd, args) => {
    if (cmd === "alert_command" && (args as { payload: { op: string } }).payload.op === "hello") listeningAtHello = emit !== null;
  });
  // Claim the console-forwarder flag so init() leaves the shared jsdom console alone.
  (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean })
    .__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;
  const adapter = new BrowserSidecarAdapter(host);
  await adapter.init();
  const since = send.mock.calls.length;
  return {
    adapter,
    deliver: (event, data) => emit?.({ event, data }),
    sent: () => send.mock.calls.slice(since).map(([cmd, args]) => [cmd, args]),
    // One subscription carries every event.
    listeningAtHello: () => listeningAtHello,
  };
}

const alertCommands = (harness: Harness) =>
  harness.sent().filter(([cmd]) => cmd === "alert_command").map(([, args]) => (args as { payload: unknown }).payload);

describe.each([
  ["TauriAdapter", tauri],
  ["BrowserSidecarAdapter", browser],
])("%s over the sidecar", (_name, open) => {
  afterEach(() => {
    resetToolDirty();
    vi.restoreAllMocks();
    build.mode = "hosted";
  });

  // docs/specs/relay.md → "Relay origin".
  it("offers managed voice only in a Hosted build", async () => {
    expect((await open()).adapter.managedVoice).toBeDefined();
    build.mode = "self-host";
    const { adapter, deliver } = await open();
    expect(adapter.managedVoice).toBeUndefined();
    // A stray broadcast has nowhere to go, and breaks nothing.
    deliver("voice:status", { configured: true, voiceId: "v1" });
  });

  it("applies dirty live/replay reports in order and preserves explicit clean across exit", async () => {
    const { deliver } = await open();
    const id = "dirty-stream";
    deliver("terminal:toolEvents", { id, events: [
      { kind: "toolState", state: { dirty: true } },
      { kind: "semantic", event: { type: "commandStart", source: "osc633_boundaries" } },
      { kind: "toolState", state: { dirty: false } },
    ] });
    deliver("terminal:semanticEvents", { id, events: [{ type: "commandStart", source: "osc633_boundaries" }] });
    expect(getToolDirty(id)).toBe(false);
    deliver("pty:exit", { id, exitCode: 0 });
    expect(getToolDirty(id)).toBe(false);
    deliver("pty:replay", { id, data: "\x1b]633;C\x07\x1b]367;state;{\"v\":1,\"dirty\":true}\x07" });
    expect(getToolDirty(id)).toBe(true);
    deliver("pty:replay", { id, data: "since-mark output without a new command" });
    expect(getToolDirty(id)).toBe(true);
    deliver("pty:replay", { id, data: "\x1b]633;C\x07" });
    expect(getToolDirty(id)).toBeNull();
  });

  it("forwards the projection pair it was handed, parsing nothing again", async () => {
    const { adapter, deliver, sent } = await open();
    const seen: PtyDataDetail[] = [];
    adapter.onPtyData((detail) => void seen.push(detail));

    // A colour query: a second parse here would answer it twice.
    deliver("pty:data", { id: "t1", data: "pre\x1b]1337;File=inline=1:AAAA\x07post", textData: "prepost" });
    deliver("pty:data", { id: "t1", data: "\x1b]11;?\x07" });

    expect(seen).toEqual([
      { id: "t1", data: "pre\x1b]1337;File=inline=1:AAAA\x07post", textData: "prepost" },
      { id: "t1", data: "\x1b]11;?\x07" },
    ]);
    expect(sent()).toEqual([]);
  });

  // A page in a browser pane can `postMessage` this window, and in VS Code the
  // host's messages arrive the same way, behind a per-boot token. Here host
  // events arrive only over the transport, so there is no inbox to forge
  // (docs/specs/security-local.md -> "Browser panes").
  it("takes no host event from a window message, whatever its shape", async () => {
    const { adapter, deliver, sent } = await open();
    const seen: PtyDataDetail[] = [];
    const alerts: AlertStateDetail[] = [];
    adapter.onPtyData((detail) => void seen.push(detail));
    adapter.onAlertState((detail) => void alerts.push(detail));

    const forged: Array<[string, Record<string, unknown>]> = [
      ["pty:data", { id: "forged", data: "x" }],
      ["alert:state", { id: "forged", status: "ALERT_RINGING", todo: true }],
      ["terminal:clipboardOffer", { id: "forged", text: "x" }],
      ["dor:controlRequest", { requestId: "dor-forged", surfaceId: "forged", cmd: "list" }],
      ["burrow:ask", { burrowRequestId: "ask-forged", op: "surfaceOp", params: {} }],
    ];
    for (const [event, payload] of forged) {
      // VS Code's host shape, the Tauri event's, and the dev harness's.
      for (const data of [{ type: event, ...payload }, { event, payload }, { event, data: payload }]) {
        window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([]);
    expect(alerts).toEqual([]);
    expect(sent()).toEqual([]);
    // The same event over the transport is heard.
    deliver("pty:data", { id: "real", data: "y" });
    expect(seen).toEqual([{ id: "real", data: "y", textData: undefined }]);
  });

  it("rebuilds pane state from a replay, and asks nothing of the alerts", async () => {
    const { adapter, deliver, sent } = await open();
    const alerts: AlertStateDetail[] = [];
    adapter.onAlertState((detail) => void alerts.push(detail));

    deliver("pty:replay", { id: "replay-pty", data: "\x1b]633;E;sleep 5\x07\x1b]633;C\x07\x1b]9;Historical\x07" });

    expect(getTerminalPaneState("replay-pty").currentCommand?.rawCommandLine).toBe("sleep 5");
    expect(alerts).toEqual([]);
    expect(sent()).toEqual([]);
  });

  // The sidecar acknowledges it and opens the echo window before it writes, so
  // the flag must ride the write itself — a separate command could lose the race.
  // A launch arms the PTY's OSC 367 open latch the same way, ahead of the shell.
  it("writes user input with its acknowledgement, and a launch with its mark, in one message", async () => {
    const { adapter, sent } = await open();
    adapter.writePty("typed", "\x1b[I");
    adapter.writePty("typed", "y", { userInput: true });
    adapter.writePty("typed", "view\r", { launch: true });
    expect(sent()).toEqual([
      ["pty_write", { id: "typed", data: "\x1b[I", paced: undefined, userInput: undefined, launch: undefined }],
      ["pty_write", { id: "typed", data: "y", paced: undefined, userInput: true, launch: undefined }],
      ["pty_write", { id: "typed", data: "view\r", paced: undefined, userInput: undefined, launch: true }],
    ]);
  });

  // A reload keeps the window label, so only this tells the sidecar the old
  // realm's engagement and parked awaits are gone — and only once this realm
  // can hear the answers.
  it("says hello once it can hear every alert event", async () => {
    const harness = await open();
    for (const event of ALERT_EVENTS) expect(harness.listeningAtHello(event)).toBe(true);
  });

  it("carries each alert verb as one alert_command and hands the sidecar's events to the client", async () => {
    const harness = await open();
    const { adapter, deliver } = harness;
    const states: AlertStateDetail[] = [];
    adapter.onAlertState((detail) => void states.push(detail));

    const handle = adapter.alertAwait("p", { until: "exit", timeoutMs: 600_000 });
    const [parked] = alertCommands(harness) as Array<{ op: string; awaitId: string }>;
    expect(parked).toMatchObject({ op: "await", id: "p", until: "exit" });
    deliver("alert:awaitResult", { awaitId: parked!.awaitId, forWindow: "main", outcome: { kind: "resolved", cause: "exit", waitedMs: 4 } });
    await expect(handle.promise).resolves.toEqual({ kind: "resolved", cause: "exit", waitedMs: 4 });

    const ringing = { id: "p", status: "ALERT_RINGING", todo: true } as unknown as AlertStateDetail;
    deliver("alert:state", ringing);
    expect(states).toEqual([ringing]);
  });

  it("settles what it parked when it shuts down", async () => {
    const { adapter } = await open();
    const handle = adapter.alertAwait("p", { until: "quiet", timeoutMs: 600_000 });
    adapter.shutdown();
    await expect(handle.promise).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("pushes the resolved theme so the sidecar can answer a colour query", async () => {
    const { adapter, sent } = await open();
    adapter.requestInit();
    expect(sent().filter(([cmd]) => cmd === "pty_theme_colors")).toEqual([["pty_theme_colors", {
      colors: { foreground: expect.any(String), background: expect.any(String), cursor: expect.any(String) },
    }]]);
  });
});
