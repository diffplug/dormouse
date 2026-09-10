import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceId } from "dormouse-lib/lib/session-types";
import { currentWindowLabel } from "./window-label";
import { tearOutWorkspace, transferWorkspaceTo } from "./workspace-move";

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

/** Where the cursor is, in the hit window's own logical client space. */
interface CursorHit {
  label: string;
  x: number;
  y: number;
}

let lastProbeAt = 0;
let probing = false;
let hoverLabel: string | null = null;

async function probe(): Promise<CursorHit | null> {
  try {
    return (await invoke<CursorHit | null>("window_at_cursor")) ?? null;
  } catch (err) {
    console.error("[workspace-drag] window_at_cursor failed", err);
    return null;
  }
}

/** Show (or clear) the drop caret in another window. Rust clears the previous
 *  one, so a caret can never be left behind in a window the pointer has left. */
function hover(hit: CursorHit | null): void {
  const label = hit && hit.label !== currentWindowLabel() ? hit.label : null;
  if (label === hoverLabel) return;
  hoverLabel = label;
  void invoke("hover_workspace_target", {
    label,
    x: hit?.x ?? 0,
    y: hit?.y ?? 0,
  }).catch((err) => console.error("[workspace-drag] hover_workspace_target failed", err));
}

function clearHover(): void {
  if (hoverLabel === null) return;
  hoverLabel = null;
  void invoke("hover_workspace_target", { label: null, x: 0, y: 0 }).catch(() => {});
}

/** Whether the release landed back inside this window's own strip, where the
 *  live reorder has already committed and there is nothing left to do. */
function insideOwnStrip(point: { clientX: number; clientY: number }): boolean {
  const strip = document.querySelector<HTMLElement>("[data-workspace-strip]");
  if (!strip) return false;
  const rect = strip.getBoundingClientRect();
  return point.clientX >= rect.left && point.clientX <= rect.right
    && point.clientY >= rect.top && point.clientY <= rect.bottom;
}

/**
 * Where the dragged tab should sit relative to the new window's top-left, so
 * the tab lands under the cursor. Centered on the tab rather than tracking the
 * exact grab point: the pointer left the tab long before the release, so its
 * offset within it is no longer a position the user is aiming with.
 */
function grabOffset(workspaceId: WorkspaceId): { x: number; y: number } {
  // Scanned rather than selected: a Workspace id is generated, not escaped, and
  // an attribute selector over one is a needless way to throw.
  const tab = [...document.querySelectorAll<HTMLElement>("[data-workspace-tab]")]
    .find((element) => element.dataset.workspaceTab === workspaceId);
  const rect = tab?.getBoundingClientRect();
  return { x: (rect?.width ?? 180) / 2, y: (rect?.height ?? 24) / 2 };
}

/** The pointer left this window's strip mid-drag. */
export function onDragOutsideWindow(_id: WorkspaceId, _point: { clientX: number; clientY: number }): void {
  const now = Date.now();
  if (probing || now - lastProbeAt < HIT_TEST_THROTTLE_MS) return;
  lastProbeAt = now;
  probing = true;
  void probe()
    .then((hit) => hover(hit))
    .finally(() => { probing = false; });
}

/**
 * The drag was released. Over another window it transfers; over nothing — or
 * over this window but outside its strip — it tears out into a new one.
 */
export function onDropOnOtherWindow(id: WorkspaceId, point: { clientX: number; clientY: number }): boolean {
  clearHover();
  if (insideOwnStrip(point)) return false;
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
  return true;
}

/** @internal Reset module state for testing. */
export function _resetWorkspaceDragForTesting(): void {
  lastProbeAt = 0;
  probing = false;
  hoverLabel = null;
}
