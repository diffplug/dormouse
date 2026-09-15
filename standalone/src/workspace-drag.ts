import { invoke } from "@tauri-apps/api/core";
import { throttleTrailing } from "dormouse-lib/lib/throttle";
import type { WorkspaceId } from "dormouse-lib/lib/session-types";
import type { StripDragPoint } from "dormouse-lib/components/workspace-strip-drag";
import { currentWindowLabel } from "./window-label";
import { tearOutWorkspace, transferWorkspaceTo } from "./workspace-move";
import { getWallHandle } from "dormouse-lib/components/wall/wall-handles";
import { randomKillChar } from "dormouse-lib/components/KillConfirm";
import { setPendingWorkspaceMove } from "dormouse-lib/lib/workspace-ui-store";
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

let probing = false;
/** A probe was wanted while one was in flight; ask again when it lands. */
let missed = false;
let lastPoint: StripDragPoint | null = null;
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

function probeNow(): void {
  const mine = generation;
  probing = true;
  void probe()
    .then((hit) => {
      if (mine === generation) hover(hit);
    })
    .finally(() => {
      probing = false;
      // The window closed on an in-flight probe: the pointer has moved since,
      // and the caret would otherwise hold wherever that answer put it.
      if (missed && mine === generation) {
        missed = false;
        askToProbe();
      }
    });
}

/**
 * Probe on the leading edge and again on the trailing one
 * (`throttleTrailing`).
 *
 * The leading edge alone never sees where the pointer came to **rest**, and the
 * resting position is the one the caret must show — a pointer that stops moving
 * inside the last throttle window would otherwise leave the caret a tab behind
 * the drop it is about to make.
 */
const askToProbe = throttleTrailing(() => {
  if (probing) {
    missed = true;
    return;
  }
  probeNow();
}, HIT_TEST_THROTTLE_MS);

/** The pointer left this window's strip mid-drag. */
export function onDragOutsideWindow(point: StripDragPoint): void {
  // A pointer that has not actually moved must not cost a round trip per
  // throttle window; a coalesced or repeated move reports the same point.
  if (lastPoint?.clientX === point.clientX && lastPoint?.clientY === point.clientY) return;
  lastPoint = point;
  askToProbe();
}

/**
 * The gesture is over, whichever way it ended. Bumping the generation is what
 * makes an in-flight probe's answer inert: it lands after the caret has been
 * cleared, and re-lighting one in a window the drag has left would burn there
 * until the next drag.
 */
function endGesture(): void {
  askToProbe.cancel();
  missed = false;
  generation += 1;
  lastPoint = null;
  hover(null);
}

/**
 * The pointer came back over this window's own strip. The in-strip reorder takes
 * over from here, and a caret still lit in another window would sit there
 * claiming a drop that is no longer going to happen.
 */
export function onDragBackInsideStrip(): void {
  endGesture();
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
  // Before the fresh probe below, so an in-flight one's answer cannot re-light
  // the caret this is about to clear.
  endGesture();
  if (insideStrip) return;
  const grab = grabOffset(id);
  void (async () => {
    // Probed fresh rather than reusing the throttled answer: up to
    // HIT_TEST_THROTTLE_MS of pointer travel could otherwise choose the window.
    const hit = await probe();
    const move = hit && hit.label !== currentWindowLabel()
      ? () => void transferWorkspaceTo(id, hit.label, { x: hit.x, y: hit.y })
      : () => void tearOutWorkspace(id, grab);
    // The one thing a move cannot carry is a plain iframe's document, Doored
    // ones included; it reopens at its saved URL. The user says so first, with
    // the same typed letter a kill takes (docs/specs/layout.md → Workspaces).
    const iframes = getWallHandle(id)?.iframeSurfaceIds() ?? [];
    if (iframes.length > 0) {
      setPendingWorkspaceMove({ id, char: randomKillChar(), iframeCount: iframes.length, proceed: move });
      return;
    }
    move();
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
  endGesture();
}

/** @internal Reset module state for testing. */
export function _resetWorkspaceDragForTesting(): void {
  askToProbe.cancel();
  missed = false;
  probing = false;
  lastPoint = null;
  hoverLabel = null;
  hoverBucket = -1;
  generation += 1;
}
