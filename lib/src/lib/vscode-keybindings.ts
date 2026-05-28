type KeyboardEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>;

/** The workbench commands the VS Code host is allowed to run on the webview's behalf. */
export const VSCODE_WORKBENCH_COMMANDS = [
  'workbench.action.quickOpen',
  'workbench.action.showCommands',
  'workbench.action.toggleSidebarVisibility',
] as const;

export type VSCodeWorkbenchCommand = (typeof VSCODE_WORKBENCH_COMMANDS)[number];

/**
 * Xterm keyboard handling changes when foreground apps enable enhanced
 * keyboard protocols, which makes VS Code workbench chords inconsistent. For
 * the allowlisted chords, Dormouse lets xterm keep processing the key and also
 * asks the VS Code host to run the matching workbench command.
 */
export function vscodeWorkbenchCommandForKeydown(
  event: KeyboardEventLike,
  options: { isMac: boolean },
): VSCodeWorkbenchCommand | null {
  if (event.type !== 'keydown') return null;
  if (event.isComposing) return null;

  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'F1') {
    return 'workbench.action.showCommands';
  }

  const platformMod = options.isMac ? event.metaKey : event.ctrlKey;
  if (!platformMod || event.altKey) return null;

  const key = event.key.toLowerCase();
  const isP = key === 'p' || event.code === 'KeyP';
  if (isP) {
    return event.shiftKey
      ? 'workbench.action.showCommands'
      : 'workbench.action.quickOpen';
  }

  const isB = key === 'b' || event.code === 'KeyB';
  if (isB && !event.shiftKey) return 'workbench.action.toggleSidebarVisibility';

  return null;
}
