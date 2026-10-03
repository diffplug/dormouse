/**
 * Whether the host reports this webview shown. VS Code keeps a hidden
 * webview's context alive (`retainContextWhenHidden`) and does not promise its
 * page goes `hidden`, so its extension says so itself; every other host leaves
 * this true and Page Visibility alone decides (`lib/src/lib/surface-sight.ts`).
 */
let shown = true;
const listeners = new Set<() => void>();

export function hostShown(): boolean {
  return shown;
}

export function setHostShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeHostShown(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
