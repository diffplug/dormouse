import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceId } from "dormouse-lib/lib/session-types";
import type { StripDragPoint } from "dormouse-lib/components/workspace-strip-drag";
import { currentWindowLabel } from "./window-label";
import { tearOutWorkspace, transferWorkspaceTo } from "./workspace-move";
import { workspaceTabRect } from "./workspace-tabs";

/**
 * The host side of the Workspace strip's drag, past the edge of its own strip
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows"). The
 * strip owns the in-window reorder and never asks anything here for it; this
 * only answers "which window is the pointer over, and what happens on release".
 *
 * A pointer captured on a tab keeps delivering `pointermove` and `pointerup`
 * outside the window (rationale), so the gesture is the webview's throughout
 * and the host is only asked where the cursor is.
 */

/** The cursor probe is an IPC round trip; a pointermove is per frame. */
const HIT_TEST_THROTTLE_MS = 60;
/** How far the pointer must travel inside the target before its caret is worth
 *  redrawing. A tab is 180px at most, so this cannot skip a whole slot. */
const HOVER_BUCKET_PX = 12;

/** Where the cursor is, in the hit window's own logical client space. */
interface CursorHit {
  label: string;
  x: number;
  y: number;
}

let lastProbeAt = 0;
let probing = false;
let lastPoint: StripDragPoint | null = null;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
let hoverLabel: string | null = null;
let hoverBucket = -1;
/**
 * Bumped by every release and every abandon. A probe is an IPC round trip that
 * can land after the gesture is over, and its answer would re-light a caret in a
 * window the drag has already left — burning there until the next drag.
 */
let generation = 0;

async function probe(): Promise<CursorHit | null> {
  try {
    return (await invoke<CursorHit | null>("window_at_cursor")) ?? null;
  } catch (err) {
    console.error("[workspace-drag] window_at_cursor failed", err);
    return null;
  }
}

/**
 * Show (or clear, with null) the drop caret in another window. Rust clears the
 * previous one, so a caret can never be left behind in a window the pointer has
 * left.
 *
 * Deduped on the window **and** where in it: keyed on the label alone the target
 * would draw its caret once and then hold it while the pointer crossed every
 * remaining tab.
 */
function hover(hit: CursorHit | null): void {
  const label = hit && hit.label !== currentWindowLabel() ? hit.label : null;
  const bucket = label ? Math.round(hit!.x / HOVER_BUCKET_PX) : -1;
  if (label === hoverLabel && bucket === hoverBucket) return;
  hoverLabel = label;
  hoverBucket = bucket;
  void invoke("hover_workspace_target", {
    label,
    x: hit?.x ?? 0,
    y: hit?.y ?? 0,
  }).catch((err) => console.error("[workspace-drag] hover_workspace_target failed", err));
}

function clearTrailing(): void {
  if (trailingTimer === null) return;
  clearTimeout(trailingTimer);
  trailingTimer = null;
}

function probeNow(): void {
  const mine = generation;
  lastProbeAt = Date.now();
  probing = true;
  void probe()
    .then((hit) => {
      if (mine === generation) hover(hit);
    })
    .finally(() => { probing = false; });
}

/**
 * Ask again once the throttle window is over.
 *
 * The leading edge alone never sees where the pointer came to **rest**, and the
 * resting position is the one the caret must show — a pointer that stops moving
 * inside the last throttle window would otherwise leave the caret a tab behind
 * the drop it is about to make.
 */
function scheduleTrailing(delay: number): void {
  if (trailingTimer !== null) return;
  const mine = generation;
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    if (mine !== generation) return;
    if (probing) {
      scheduleTrailing(HIT_TEST_THROTTLE_MS);
      return;
    }
    probeNow();
  }, delay);
}

/** The pointer left this window's strip mid-drag. */
export function onDragOutsideWindow(point: StripDragPoint): void {
  // A pointer that has not actually moved must not cost a round trip per
  // throttle window; a coalesced or repeated move reports the same point.
  if (lastPoint?.clientX === point.clientX && lastPoint?.clientY === point.clientY) return;
  lastPoint = point;
  const wait = HIT_TEST_THROTTLE_MS - (Date.now() - lastProbeAt);
  if (probing || wait > 0) {
    scheduleTrailing(Math.max(wait, 0));
    return;
  }
  probeNow();
}

/**
 * The pointer came back over this window's own strip. The in-strip reorder takes
 * over from here, and a caret still lit in another window would sit there
 * claiming a drop that is no longer going to happen.
 */
export function onDragBackInsideStrip(): void {
  clearTrailing();
  generation += 1;
  lastPoint = null;
  hover(null);
}

/**
 * The drag was released. `insideStrip` is the strip controller's own answer —
 * it owns the strip box — and means the live reorder has already committed the
 * move, so there is nothing left to do but drop the caret. Over another window
 * it transfers; over nothing — or over this window but outside its strip — it
 * tears out into a new one.
 */
export function onDropOnOtherWindow(
  id: WorkspaceId,
  _point: StripDragPoint,
  insideStrip: boolean,
): void {
  // Before the hover, so an in-flight probe's answer cannot re-light the caret
  // this is about to clear.
  clearTrailing();
  generation += 1;
  hover(null);
  lastPoint = null;
  if (insideStrip) return;
  const grab = grabOffset(id);
  void (async () => {
    // Probed fresh rather than reusing the throttled answer: up to
    // HIT_TEST_THROTTLE_MS of pointer travel could otherwise choose the window.
    const hit = await probe();
    if (hit && hit.label !== currentWindowLabel()) {
      await transferWorkspaceTo(id, hit.label, { x: hit.x, y: hit.y });
      return;
    }
    await tearOutWorkspace(id, grab);
  })();
}

/**
 * Where the dragged tab should sit relative to the new window's top-left, so
 * the tab lands under the cursor. Centered on the tab rather than tracking the
 * exact grab point: the pointer left the tab long before the release, so its
 * offset within it is no longer a position the user is aiming with.
 */
function grabOffset(workspaceId: WorkspaceId): { x: number; y: number } {
  const rect = workspaceTabRect(workspaceId);
  return { x: (rect?.width ?? 180) / 2, y: (rect?.height ?? 24) / 2 };
}

/** The drag was abandoned — `pointercancel`, or Escape. Nothing moves, but a
 *  caret lit in another window would otherwise be stranded there. */
export function onDragCancelled(): void {
  clearTrailing();
  generation += 1;
  hover(null);
  lastPoint = null;
}

/** @internal Reset module state for testing. */
export function _resetWorkspaceDragForTesting(): void {
  clearTrailing();
  lastProbeAt = 0;
  probing = false;
  lastPoint = null;
  hoverLabel = null;
  hoverBucket = -1;
  generation += 1;
}
