// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host side of the strip drag: where the cursor is, what the release does,
 * and the caret it leaves in the window it is over
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows").
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  transferWorkspaceTo: vi.fn(async () => {}),
  tearOutWorkspace: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workspace-move", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-move")>()),
  transferWorkspaceTo: mocks.transferWorkspaceTo,
  tearOutWorkspace: mocks.tearOutWorkspace,
}));

import {
  onDragOutsideWindow,
  onDropOnOtherWindow,
  _resetWorkspaceDragForTesting,
} from "./workspace-drag";
import { _setWindowLabelForTesting } from "./window-label";

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Past the hit-test throttle, so the next move probes again. */
const throttleElapsed = () => vi.advanceTimersByTimeAsync(100);
const hovers = (): Array<Record<string, unknown>> =>
  mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "hover_workspace_target")
    .map(([, args]) => args as Record<string, unknown>);
const lastHover = () => hovers()[hovers().length - 1];
const probes = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "window_at_cursor").length;

/** What `window_at_cursor` answers next. */
let hit: { label: string; x: number; y: number } | null = null;

function strip(rect: Partial<DOMRect>): void {
  document.body.innerHTML = "";
  const element = document.createElement("div");
  element.dataset.workspaceStrip = "";
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 30, ...rect }) as DOMRect;
  document.body.append(element);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetWorkspaceDragForTesting();
  _setWindowLabelForTesting("main");
  hit = null;
  mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "window_at_cursor" ? hit : undefined));
  strip({});
});

afterEach(() => vi.useRealTimers());

describe("hit testing while dragging", () => {
  it("probes at most once per throttle window", async () => {
    for (let i = 0; i < 10; i += 1) onDragOutsideWindow("ws-1", { clientX: i, clientY: 100 });
    await settle();
    expect(probes()).toBe(1);
  });

  it("shows a caret in the window under the cursor and clears the one it left", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow("ws-1", { clientX: 900, clientY: 8 });
    await settle();
    expect(hovers()).toEqual([{ label: "ws-2", x: 40, y: 8 }]);

    // Moved onto a different window: Rust clears the previous caret itself, so
    // the host only names the new one.
    hit = { label: "ws-3", x: 12, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow("ws-1", { clientX: 1400, clientY: 8 });
    await settle();
    expect(lastHover()).toEqual({ label: "ws-3", x: 12, y: 8 });

    // Over nothing at all.
    hit = null;
    await throttleElapsed();
    onDragOutsideWindow("ws-1", { clientX: 2000, clientY: 800 });
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0 });
  });

  it("never shows a caret in its own window", async () => {
    hit = { label: "main", x: 40, y: 8 };
    onDragOutsideWindow("ws-1", { clientX: 100, clientY: 400 });
    await settle();
    expect(hovers()).toEqual([]);
  });
});

describe("releasing the drag", () => {
  it("does nothing when released back inside its own strip", async () => {
    expect(onDropOnOtherWindow("ws-1", { clientX: 100, clientY: 10 })).toBe(false);
    await settle();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("transfers to the window it was released over", async () => {
    hit = { label: "ws-2", x: 120, y: 9 };
    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 9 });
    await settle();
    expect(mocks.transferWorkspaceTo).toHaveBeenCalledWith("ws-1", "ws-2", { x: 120, y: 9 });
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("tears out when released over no window", async () => {
    hit = null;
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 });
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.objectContaining({ x: 90, y: 12 }));
  });

  it("tears out when released inside its own window but outside the strip", async () => {
    // The browser gesture: drag the tab down into the body and let go.
    hit = { label: "main", x: 300, y: 400 };
    onDropOnOtherWindow("ws-1", { clientX: 300, clientY: 400 });
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalled();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
  });

  it("clears the hover caret on release", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow("ws-1", { clientX: 900, clientY: 8 });
    await settle();
    mocks.invoke.mockClear();

    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 8 });
    await settle();
    expect(hovers()[0]).toEqual({ label: null, x: 0, y: 0 });
  });
});
