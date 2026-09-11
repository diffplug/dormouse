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
  onDragBackInsideStrip,
  onDragCancelled,
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

/** One tab in this window's strip, so the tear-out grab offset can measure it. */
function strip(): void {
  document.body.innerHTML = "";
  const tab = document.createElement("div");
  tab.dataset.workspaceTab = "ws-1";
  tab.getBoundingClientRect = () => ({ left: 0, width: 180, height: 24 }) as DOMRect;
  document.body.append(tab);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetWorkspaceDragForTesting();
  _setWindowLabelForTesting("main");
  hit = null;
  mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "window_at_cursor" ? hit : undefined));
  strip();
});

afterEach(() => vi.useRealTimers());

describe("hit testing while dragging", () => {
  it("probes at most once per throttle window", async () => {
    for (let i = 0; i < 10; i += 1) onDragOutsideWindow({ clientX: i, clientY: 100 });
    await settle();
    expect(probes()).toBe(1);
  });

  it("never probes for a pointer that has not moved", async () => {
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(probes()).toBe(1);
    // A repeated move at the same point is not a new question, so it must not
    // cost a round trip once the throttle window is over.
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(probes()).toBe(1);
  });

  it("shows a caret in the window under the cursor and clears the one it left", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(hovers()).toEqual([{ label: "ws-2", x: 40, y: 8 }]);

    // Moved onto a different window: Rust clears the previous caret itself, so
    // the host only names the new one.
    hit = { label: "ws-3", x: 12, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1400, clientY: 8 });
    await settle();
    expect(lastHover()).toEqual({ label: "ws-3", x: 12, y: 8 });

    // Over nothing at all.
    hit = null;
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 2000, clientY: 800 });
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0 });
  });

  it("follows the pointer across the target's tabs instead of lighting one caret", async () => {
    hit = { label: "ws-2", x: 10, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(hovers()).toHaveLength(1);

    // Same window, well past the next tab: the target has to be told, or its
    // caret stays where the pointer first entered.
    hit = { label: "ws-2", x: 260, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1150, clientY: 8 });
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 260, y: 8 });

    // A pixel of travel inside the same slot is not worth an IPC hop.
    hit = { label: "ws-2", x: 261, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1151, clientY: 8 });
    await settle();
    expect(hovers()).toHaveLength(2);
  });

  it("probes again where the pointer came to rest", async () => {
    // The leading edge alone never sees the resting position, which is the one
    // the caret must show and the one the drop uses.
    hit = { label: "ws-2", x: 10, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(probes()).toBe(1);

    // Inside the same throttle window, and then the pointer stops.
    hit = { label: "ws-2", x: 300, y: 8 };
    onDragOutsideWindow({ clientX: 1190, clientY: 8 });
    await settle();
    expect(probes()).toBe(1);

    await throttleElapsed();
    expect(probes()).toBe(2);
    expect(lastHover()).toEqual({ label: "ws-2", x: 300, y: 8 });
  });

  it("clears the caret when the pointer comes back over its own strip", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 40, y: 8 });

    // The in-strip reorder takes the gesture back; a caret left burning in the
    // other window claims a drop that is no longer going to happen.
    onDragBackInsideStrip();
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0 });
  });

  it("never shows a caret in its own window", async () => {
    hit = { label: "main", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 100, clientY: 400 });
    await settle();
    expect(hovers()).toEqual([]);
  });
});

describe("releasing the drag", () => {
  it("does nothing when released back inside its own strip", async () => {
    // The strip controller owns its own box, so it says so rather than leaving
    // this to re-derive it from the DOM.
    onDropOnOtherWindow("ws-1", { clientX: 100, clientY: 10 }, true);
    await settle();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("transfers to the window it was released over", async () => {
    hit = { label: "ws-2", x: 120, y: 9 };
    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 9 }, false);
    await settle();
    expect(mocks.transferWorkspaceTo).toHaveBeenCalledWith("ws-1", "ws-2", { x: 120, y: 9 });
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("tears out when released over no window", async () => {
    hit = null;
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.objectContaining({ x: 90, y: 12 }));
  });

  it("tears out when released inside its own window but outside the strip", async () => {
    // The browser gesture: drag the tab down into the body and let go.
    hit = { label: "main", x: 300, y: 400 };
    onDropOnOtherWindow("ws-1", { clientX: 300, clientY: 400 }, false);
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalled();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
  });

  it("clears the hover caret on release", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    mocks.invoke.mockClear();

    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 8 }, true);
    await settle();
    expect(hovers()[0]).toEqual({ label: null, x: 0, y: 0 });
  });

  it("ignores a probe that lands after the release", async () => {
    // A caret is lit, so the release has something to clear.
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 40, y: 8 });

    // A probe is an IPC round trip that can outlive the gesture. Park one.
    let answerProbe!: (hit: { label: string; x: number; y: number } | null) => void;
    let parked = false;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "window_at_cursor" || parked) return undefined;
      parked = true;
      return new Promise((resolve) => { answerProbe = resolve; });
    });
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1400, clientY: 8 });
    await settle();

    onDropOnOtherWindow("ws-1", { clientX: 1400, clientY: 8 }, true);
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0 });
    const cleared = hovers().length;

    // The stale answer arrives — and must not re-light a caret in a window the
    // drag has already left, where it would burn until the next drag.
    answerProbe({ label: "ws-3", x: 12, y: 8 });
    await settle();
    expect(hovers()).toHaveLength(cleared);
  });

  it("clears the hover caret when the drag is abandoned", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 });
    await settle();
    mocks.invoke.mockClear();

    // pointercancel, or Escape: nothing moves, and the caret must not be left
    // burning in the window the pointer happened to be over.
    onDragCancelled();
    await settle();
    expect(hovers()[0]).toEqual({ label: null, x: 0, y: 0 });
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });
});
