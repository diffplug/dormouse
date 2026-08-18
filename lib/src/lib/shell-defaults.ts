// Shared "currently selected" shell, used when spawning without an explicit
// choice (e.g. a keyboard-driven split). Written by `shell-store.ts` — seeded
// before standalone Wall mount, then again on every Settings-dialog Shell-row
// selection — and by the VSCode extension pushing dormouse:selectedShell.
//
// Extracted into its own module to avoid circular dependencies between
// terminal-registry and platform/vscode-adapter.

let defaultShellOpts: { shell?: string; args?: string[] } | null = null;

export function setDefaultShellOpts(opts: { shell?: string; args?: string[] } | null): void {
  defaultShellOpts = opts;
}

export function getDefaultShellOpts(): { shell?: string; args?: string[] } | null {
  return defaultShellOpts;
}
