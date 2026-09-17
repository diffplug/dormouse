/** The strip lives outside the Wall; keyboard selection and its ring resolve
 * the same rendered target. A null id denotes the New Workspace button. */
export function workspaceTabElement(id: string | null): HTMLElement | null {
  if (id === null) return document.querySelector('[data-workspace-new]');
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-tab]')]
    .find(element => element.dataset.workspaceTab === id) ?? null;
}
