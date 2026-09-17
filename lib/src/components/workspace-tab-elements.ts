/** Every Workspace tab in strip order. The strip renders outside every Wall, so
 *  the DOM is what its measurers share. */
export function workspaceTabElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-tab]')];
}

/** The strip lives outside the Wall; keyboard selection and its ring resolve
 * the same rendered target. A null id denotes the New Workspace button. */
export function workspaceTabElement(id: string | null): HTMLElement | null {
  if (id === null) return document.querySelector('[data-workspace-new]');
  // Scanned rather than selected: a Workspace id is generated, not escaped, and
  // an attribute selector over one is a needless way to throw.
  return workspaceTabElements().find(element => element.dataset.workspaceTab === id) ?? null;
}

/** Scroll a tab (or the New Workspace button) into the strip's visible range. */
export function revealWorkspaceTab(element: HTMLElement | null): void {
  element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
