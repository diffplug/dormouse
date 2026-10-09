// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host side of the strip drag: where the cursor is, what the release does,
 * and the caret it leaves in the window it is over
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows").
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  transferWorkspaceTo: vi.fn(async (): Promise<import('./workspace-move').MoveOutcome> => ({ moved: true })),
  tearOutWorkspace: vi.fn(async (): Promise<import('./workspace-move').MoveOutcome> => ({ moved: true })),
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
  moveWorkspaceToNewWindow,
  _resetWorkspaceDragForTesting,
} from "./workspace-drag";
import { _setWindowLabelForTesting } from "./window-label";
import { registerWallHandle, resetWallHandles, stubWallHandle } from "dormouse-lib/components/wall/wall-handles";
import { createWorkspace, resetWorkspaces } from "dormouse-lib/lib/workspace-store";
import { cancelPendingConfirmation, getWorkspaceUiSnapshot, requestConfirmation, resetWorkspaceUi, settleConfirmation } from "dormouse-lib/lib/workspace-ui-store";

import { cancelEditorClose, decideEditorClose, getEditorClosePrompt } from "dormouse-lib/lib/tool-editor";
import { recordToolDirty, resetToolDirty } from "dormouse-lib/lib/tool-dirty-store";

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
  cancelEditorClose();
  resetToolDirty();
  resetWallHandles();
  resetWorkspaceUi();
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetWorkspaceDragForTesting();
  _setWindowLabelForTesting("main");
  hit = null;
  mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "window_at_cursor" ? hit : undefined));
  strip();
});

afterEach(() => { cancelEditorClose(); vi.useRealTimers(); });

describe("hit testing while dragging", () => {
  it("probes at most once per throttle window", async () => {
    for (let i = 0; i < 10; i += 1) onDragOutsideWindow({ clientX: i, clientY: 100 }, "ws-1");
    await settle();
    expect(probes()).toBe(1);
  });

  it("never probes for a pointer that has not moved", async () => {
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(probes()).toBe(1);
    // A repeated move at the same point is not a new question, so it must not
    // cost a round trip once the throttle window is over.
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(probes()).toBe(1);
  });

  it("shows a caret in the window under the cursor and clears the one it left", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(hovers()).toEqual([{ label: "ws-2", x: 40, y: 8, pinned: false }]);

    // Moved onto a different window: Rust clears the previous caret itself, so
    // the host only names the new one.
    hit = { label: "ws-3", x: 12, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1400, clientY: 8 }, "ws-1");
    await settle();
    expect(lastHover()).toEqual({ label: "ws-3", x: 12, y: 8, pinned: false });

    // Over nothing at all.
    hit = null;
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 2000, clientY: 800 }, "ws-1");
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0, pinned: false });
  });

  it("follows the pointer across the target's tabs instead of lighting one caret", async () => {
    hit = { label: "ws-2", x: 10, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(hovers()).toHaveLength(1);

    // Same window, well past the next tab: the target has to be told, or its
    // caret stays where the pointer first entered.
    hit = { label: "ws-2", x: 260, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1150, clientY: 8 }, "ws-1");
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 260, y: 8, pinned: false });

    // A pixel of travel inside the same slot is not worth an IPC hop.
    hit = { label: "ws-2", x: 261, y: 8 };
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1151, clientY: 8 }, "ws-1");
    await settle();
    expect(hovers()).toHaveLength(2);
  });

  it("probes again where the pointer came to rest", async () => {
    // The leading edge alone never sees the resting position, which is the one
    // the caret must show and the one the drop uses.
    hit = { label: "ws-2", x: 10, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(probes()).toBe(1);

    // Inside the same throttle window, and then the pointer stops.
    hit = { label: "ws-2", x: 300, y: 8 };
    onDragOutsideWindow({ clientX: 1190, clientY: 8 }, "ws-1");
    await settle();
    expect(probes()).toBe(1);

    await throttleElapsed();
    expect(probes()).toBe(2);
    expect(lastHover()).toEqual({ label: "ws-2", x: 300, y: 8, pinned: false });
  });

  it("clears the caret when the pointer comes back over its own strip", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 40, y: 8, pinned: false });

    // The in-strip reorder takes the gesture back; a caret left burning in the
    // other window claims a drop that is no longer going to happen.
    onDragBackInsideStrip();
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0, pinned: false });
  });

  it("tells the target the dragged Workspace is pinned, so its caret keeps to the pinned group", async () => {
    createWorkspace({ id: "ws-pinned", pinned: true });
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-pinned");
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 40, y: 8, pinned: true });
    resetWorkspaces();
  });

  it("never shows a caret in its own window", async () => {
    hit = { label: "main", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 100, clientY: 400 }, "ws-1");
    await settle();
    expect(hovers()).toEqual([]);
  });
});

describe("the tab menu's Move to new window", () => {
  it("tears out without asking where the cursor is", async () => {
    moveWorkspaceToNewWindow("ws-1");
    await settle();
    expect(probes()).toBe(0);
    expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.objectContaining({ x: 90, y: 12 }), []);
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
  });

  it("asks the iframe question a drag asks, and answers a pending one no", async () => {
    const answer = vi.fn();
    requestConfirmation({ id: "ws-other", char: "q", answer });
    registerWallHandle(stubWallHandle("ws-1", { iframeSurfaceIds: () => ["surface:4"] }));
    moveWorkspaceToNewWindow("ws-1");
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    await settle();
    const pending = getWorkspaceUiSnapshot().confirmation;
    expect(pending).toMatchObject({ id: "ws-1", title: "Move and lose page state?" });
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
    settleConfirmation(pending!, true);
    expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.any(Object), []);
  });
});

describe("releasing the drag", () => {
  it.each([true, false])("protects dirty drafts before the iframe gate (existing window: %s)", async (existing) => {
    recordToolDirty("editor", true);
    registerWallHandle(stubWallHandle("ws-1", {
      dirtyToolIds: () => ["editor"], iframeSurfaceIds: () => ["surface:4"],
    }));
    hit = existing ? { label: "ws-2", x: 120, y: 9 } : null;
    const drop = () => onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 9 }, false);
    drop();
    await settle();
    expect(getEditorClosePrompt()?.items).toMatchObject([{ id: "editor" }]);
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    await decideEditorClose("cancel");
    await settle();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();

    drop();
    await settle();
    await decideEditorClose("discard");
    await settle();
    const pending = getWorkspaceUiSnapshot().confirmation;
    expect(pending).toMatchObject({ detail: expect.stringContaining("An iframe Surface") });
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
    settleConfirmation(pending!, true);
    if (existing) expect(mocks.transferWorkspaceTo).toHaveBeenCalledWith("ws-1", "ws-2", { x: 120, y: 9 }, undefined, ["editor"]);
    else expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.any(Object), ["editor"]);
  });

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
    expect(mocks.transferWorkspaceTo).toHaveBeenCalledWith("ws-1", "ws-2", { x: 120, y: 9 }, undefined, []);
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("asks first when the Workspace holds an iframe, and moves only on the typed letter", async () => {
    resetWallHandles();
    resetWorkspaceUi();
    registerWallHandle(stubWallHandle("ws-1", { iframeSurfaceIds: () => ["browser-1", "browser-2"] }));
    hit = { label: "ws-2", x: 120, y: 9 };
    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 9 }, false);
    await settle();
    // Nothing moved: the gate is up, naming what it would cost.
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    const pending = getWorkspaceUiSnapshot().confirmation;
    expect(pending).toMatchObject({ id: "ws-1", title: "Move and lose page state?", detail: expect.stringContaining("2 iframe Surfaces") });
    // The strip's key handler settles it; here, the letter's own effect.
    settleConfirmation(pending!, true);
    expect(mocks.transferWorkspaceTo).toHaveBeenCalledWith("ws-1", "ws-2", { x: 120, y: 9 }, undefined, []);
    resetWallHandles();
    resetWorkspaceUi();
  });

  it("does not ask for a Workspace of terminals and agent-browser Surfaces", async () => {
    resetWallHandles();
    registerWallHandle(stubWallHandle("ws-1", { iframeSurfaceIds: () => [] }));
    hit = null;
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalled();
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    resetWallHandles();
  });

  it("abandons an older window probe when a newer confirmation is raised", async () => {
    let resolveProbe!: (hit: { label: string; x: number; y: number }) => void;
    const probe = new Promise<{ label: string; x: number; y: number }>(resolve => { resolveProbe = resolve; });
    mocks.invoke.mockImplementation(async cmd => cmd === "window_at_cursor" ? probe : undefined);
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    const newer = { id: "ws-other", char: "q", answer: vi.fn() };
    requestConfirmation(newer);
    resolveProbe({ label: "ws-2", x: 120, y: 9 });
    await settle();
    expect(getWorkspaceUiSnapshot().confirmation).toBe(newer);
    expect(newer.answer).not.toHaveBeenCalled();
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
  });

  it("abandons a dirty-editor decision when a newer move starts", async () => {
    recordToolDirty("editor", true);
    registerWallHandle(stubWallHandle("ws-1", { dirtyToolIds: () => ["editor"], iframeSurfaceIds: () => ["surface:4"] }));
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    await settle();
    expect(getEditorClosePrompt()).not.toBeNull();
    cancelPendingConfirmation();
    await decideEditorClose("discard");
    await settle();
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });

  it("answers a pending confirmation no as the drop starts its move", () => {
    const answer = vi.fn();
    requestConfirmation({ id: "ws-other", char: "q", answer });
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
  });

  it("tears out when released over no window", async () => {
    hit = null;
    onDropOnOtherWindow("ws-1", { clientX: 2000, clientY: 800 }, false);
    await settle();
    expect(mocks.tearOutWorkspace).toHaveBeenCalledWith("ws-1", expect.objectContaining({ x: 90, y: 12 }), []);
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
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    mocks.invoke.mockClear();

    onDropOnOtherWindow("ws-1", { clientX: 900, clientY: 8 }, true);
    await settle();
    expect(hovers()[0]).toEqual({ label: null, x: 0, y: 0, pinned: false });
  });

  it("ignores a probe that lands after the release", async () => {
    // A caret is lit, so the release has something to clear.
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    expect(lastHover()).toEqual({ label: "ws-2", x: 40, y: 8, pinned: false });

    // A probe is an IPC round trip that can outlive the gesture. Park one.
    let answerProbe!: (hit: { label: string; x: number; y: number } | null) => void;
    let parked = false;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "window_at_cursor" || parked) return undefined;
      parked = true;
      return new Promise((resolve) => { answerProbe = resolve; });
    });
    await throttleElapsed();
    onDragOutsideWindow({ clientX: 1400, clientY: 8 }, "ws-1");
    await settle();

    onDropOnOtherWindow("ws-1", { clientX: 1400, clientY: 8 }, true);
    await settle();
    expect(lastHover()).toEqual({ label: null, x: 0, y: 0, pinned: false });
    const cleared = hovers().length;

    // The stale answer arrives — and must not re-light a caret in a window the
    // drag has already left, where it would burn until the next drag.
    answerProbe({ label: "ws-3", x: 12, y: 8 });
    await settle();
    expect(hovers()).toHaveLength(cleared);
  });

  it("clears the hover caret when the drag is abandoned", async () => {
    hit = { label: "ws-2", x: 40, y: 8 };
    onDragOutsideWindow({ clientX: 900, clientY: 8 }, "ws-1");
    await settle();
    mocks.invoke.mockClear();

    // pointercancel, or Escape: nothing moves, and the caret must not be left
    // burning in the window the pointer happened to be over.
    onDragCancelled();
    await settle();
    expect(hovers()[0]).toEqual({ label: null, x: 0, y: 0, pinned: false });
    expect(mocks.transferWorkspaceTo).not.toHaveBeenCalled();
    expect(mocks.tearOutWorkspace).not.toHaveBeenCalled();
  });
});


it.each([false, true])('shows a blocked Tool move reason for drag transfer and tear-out (%s)', async transfer => {
  hit = transfer ? { label: 'ws-2', x: 10, y: 4 } : null;
  const move = transfer ? mocks.transferWorkspaceTo : mocks.tearOutWorkspace;
  const reason = 'Approve or decline pending Tools before moving this Workspace';
  move.mockResolvedValueOnce({ moved: false, reason });
  onDropOnOtherWindow('ws-1', { clientX: 900, clientY: 8 }, false);
  await settle();
  expect(getWorkspaceUiSnapshot().moveError).toEqual({ id: 'ws-1', reason });
  onDropOnOtherWindow('ws-1', { clientX: 900, clientY: 8 }, false);
  await settle();
  expect(getWorkspaceUiSnapshot().moveError).toBeNull();
});
