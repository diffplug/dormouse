import type { WorkspaceId } from "dormouse-lib/lib/session-types";

/**
 * One scan of this window's Workspace strip, shared by everything that has to
 * measure it: the drop index an arriving Workspace takes, the caret another
 * window's drag draws, and where a torn-out tab should sit under the cursor
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows").
 *
 * The strip renders in the AppBar, outside every Wall, so the DOM is the only
 * thing all three of them share.
 */

/** Every tab, in strip order. */
function tabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-workspace-tab]")];
}

export interface WorkspaceDropTarget {
  /** The index a drop takes. Undefined appends, which is also what a drop past
   *  the last tab means. */
  index: number | undefined;
  /** The box the caret draws against — the tab at `index`, or the last one when
   *  appending. Null when the strip has no tabs at all. */
  rect: DOMRect | null;
}

/** Where a drop at viewport `x` lands in this window's strip. */
export function workspaceDropTarget(x: number): WorkspaceDropTarget {
  const elements = tabs();
  for (const [index, tab] of elements.entries()) {
    const rect = tab.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) return { index, rect };
  }
  const last = elements[elements.length - 1];
  return { index: undefined, rect: last ? last.getBoundingClientRect() : null };
}

/** One Workspace's tab box, or null when it is not rendered. */
export function workspaceTabRect(workspaceId: WorkspaceId): DOMRect | null {
  // Scanned rather than selected: a Workspace id is generated, not escaped, and
  // an attribute selector over one is a needless way to throw.
  return tabs()
    .find((tab) => tab.dataset.workspaceTab === workspaceId)
    ?.getBoundingClientRect() ?? null;
}
