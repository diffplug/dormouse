import * as vscode from 'vscode';

export interface ShellEntry {
  name: string;
  path: string;
  args: string[];
}

const KEY = 'dormouse.selectedShellPath';

export function getSelectedShellPath(context: vscode.ExtensionContext): string | undefined {
  return context.workspaceState.get<string>(KEY) ?? context.globalState.get<string>(KEY);
}

export async function setSelectedShellPath(
  context: vscode.ExtensionContext,
  path: string,
  scope: 'workspace' | 'global',
): Promise<void> {
  if (scope === 'workspace') {
    await context.workspaceState.update(KEY, path);
  } else {
    // Clear any workspace-scoped value so it doesn't shadow the new global
    // setting (getSelectedShellPath checks workspaceState first).
    await context.workspaceState.update(KEY, undefined);
    await context.globalState.update(KEY, path);
  }
}

export function resolveSelectedShell(
  context: vscode.ExtensionContext,
  shells: ShellEntry[],
): ShellEntry | undefined {
  const saved = getSelectedShellPath(context);
  return shells.find((s) => s.path === saved) ?? shells[0];
}
