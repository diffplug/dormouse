import type { WorkspaceId } from "dormouse-lib/lib/session-types";
import { workspaceTabElement, workspaceTabElements } from "dormouse-lib/components/workspace-tab-elements";

/**
 * One scan of this window's Workspace strip, shared by everything that has to
 * measure it: the drop index an arriving Workspace takes, the caret another
 * window's drag draws, and where a torn-out tab should sit under the cursor
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows").
 *
 * The strip renders in the AppBar, outside every Wall, so the DOM is the only
 * thing all three of them share.
 */

export interface WorkspaceDropTarget {
  /** The index a drop takes. Undefined appends, which is also what a drop past
   *  the last tab means. */
  index: number | undefined;
  /** The box the caret draws against: the tab the drop goes before, else the
   *  one it goes after (or `+`, for the first pinned tab). Null when the
   *  arriving Workspace's group has nothing to draw against. */
  rect: DOMRect | null;
  /** Which edge of `rect` the caret takes. */
  edge: "left" | "right";
}

/**
 * Where a drop at viewport `x` lands in this window's strip, clamped into the
 * arriving Workspace's own group as the store clamps the drop itself
 * (`docs/specs/layout.md` → "Workspace tabs"): an unpinned arrival never lands
 * among pinned tabs, nor a pinned one among unpinned tabs.
 */
export function workspaceDropTarget(x: number, pinned = false): WorkspaceDropTarget {
  const elements = workspaceTabElements();
  const firstPinned = elements.findIndex((tab) => tab.closest("[data-workspace-pinned-group]") !== null);
  const boundary = firstPinned === -1 ? elements.length : firstPinned;
  const [low, high] = pinned ? [boundary, elements.length] : [0, boundary];
  let index = elements.findIndex((tab) => {
    const rect = tab.getBoundingClientRect();
    return x < rect.left + rect.width / 2;
  });
  if (index === -1) index = elements.length;
  index = Math.max(low, Math.min(high, index));
  const at = index === elements.length ? undefined : index;
  if (index < high) return { index: at, rect: elements[index].getBoundingClientRect(), edge: "left" };
  if (high > low) return { index: at, rect: elements[high - 1].getBoundingClientRect(), edge: "right" };
  // The group is empty: a pinned arrival lands just after `+`, an unpinned one
  // at the strip's start.
  const plus = pinned ? workspaceTabElement(null) : null;
  return { index: at, rect: plus?.getBoundingClientRect() ?? null, edge: "right" };
}

/** One Workspace's tab box, or null when it is not rendered. */
export function workspaceTabRect(workspaceId: WorkspaceId): DOMRect | null {
  return workspaceTabElement(workspaceId)?.getBoundingClientRect() ?? null;
}
