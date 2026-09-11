import { listenToWindow } from "./window-label";
import { workspaceDropTarget } from "./workspace-tabs";

/**
 * The caret another window's drag draws in this window's strip
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows"). Rust
 * pushes the hovered point, and clears it in the window the pointer left, so a
 * caret can never be stranded.
 *
 * Its whole job is to make the hit test's guess visible before the release:
 * the OS exposes no z-order, so a drag over stacked windows picks the most
 * recently focused, and this is where a wrong guess shows.
 */

/** Viewport x of the insertion line, or null while nothing is hovering. */
let caretX: number | null = null;
const listeners = new Set<() => void>();

export function subscribeDropCaret(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function getDropCaretX(): number | null {
  return caretX;
}

function set(next: number | null): void {
  if (next === caretX) return;
  caretX = next;
  for (const listener of listeners) listener();
}

/** Where the tab would be inserted, as a viewport x. */
function caretFor(point: { x: number; y: number }): number | null {
  const { index, rect } = workspaceDropTarget(point.x);
  // An empty strip has no tab to draw against, so the caret sits at its start.
  if (!rect) {
    return document.querySelector<HTMLElement>("[data-workspace-strip]")?.getBoundingClientRect().left ?? null;
  }
  return index === undefined ? rect.right : rect.left;
}

export function initDropCaret(): void {
  void listenToWindow<{ x: number; y: number } | null>("dormouse://workspace-drop-hover", (event) => {
    set(event.payload ? caretFor(event.payload) : null);
  });
}

/** @internal Reset module state for testing. */
export function _resetDropCaretForTesting(): void {
  caretX = null;
  listeners.clear();
}
