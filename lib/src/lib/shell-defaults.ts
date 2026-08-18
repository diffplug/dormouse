// Shared "currently selected" shell, used when spawning without an explicit
// choice (e.g. a keyboard-driven split). Written by `shell-store.ts` — seeded
// before standalone Wall mount, then again on every Settings-dialog Shell-row
// selection — and by the VSCode extension pushing dormouse:selectedShell.
//
// Deliberately dependency-free (no DOM, no localStorage), so it is also the
// home of the `ShellEntry` shape: `platform/types.ts` is consumed from Node via
// `lib/src/host/`, and must not reach into the browser-only `shell-store.ts`
// for it. Being dependency-free is also what avoids circular dependencies
// between terminal-registry and platform/vscode-adapter.

/** One detected shell. The canonical shape every adapter's
 *  `getAvailableShells()` returns. Re-exported from `shell-store.ts` for the
 *  UI-side importers. */
export interface ShellEntry {
  name: string;
  path: string;
  args?: string[];
}

let defaultShellOpts: { shell?: string; args?: string[] } | null = null;

export function setDefaultShellOpts(opts: { shell?: string; args?: string[] } | null): void {
  defaultShellOpts = opts;
}

export function getDefaultShellOpts(): { shell?: string; args?: string[] } | null {
  return defaultShellOpts;
}
