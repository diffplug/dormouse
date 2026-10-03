import { getHelper } from '../../lib/helper-terminal';
import { getTerminalPaneState, isUntouched } from '../../lib/terminal-registry';
import { registry } from '../../lib/terminal-store';
import { getToolDirty } from '../../lib/tool-dirty-store';
import { isToolParams, resolveRenderMode, surfaceKindFromParams, toolScopeFromParams } from './browser-surface';

/**
 * What a user close of one Surface does, decided at the close from state
 * already in memory (`docs/specs/reopen.md` → "Reopenable kinds"):
 *
 * - `trivial` closes at once and leaves no trace;
 * - `reopenable` closes at once onto the reopen stack;
 * - `confirm` asks first.
 */
export type CloseKind = 'trivial' | 'reopenable' | 'confirm';

/**
 * An untouched shell that is not running and owns no helper with user work.
 * Pending or unknown state is not idle: a helper the host has not yet answered
 * for confirms.
 */
function isTrivialShell(id: string): boolean {
  if (!isUntouched(id)) return false;
  if (getTerminalPaneState(id).activity.kind === 'running') return false;
  const helper = getHelper(id);
  if (!helper) return true;
  const helperEntry = registry.get(helper.id);
  return helperEntry?.untouched === true && (helperEntry.exited === true || helperEntry.helperBusy === false);
}

/**
 * A built-in viewer whose command still runs: a folder always, a file once it
 * has reported clean. Every other Tool — and one whose command has ended,
 * leaving its shell — confirms.
 */
function isReopenableBuiltin(id: string, params: unknown): boolean {
  if (!isToolParams(params) || toolScopeFromParams(params) !== 'builtin' || !getTerminalPaneState(id).currentCommand) return false;
  switch (params.toolName) {
    case 'folder': return true;
    case 'file': return getToolDirty(id) === false;
    default: return false;
  }
}

export function closeKind(id: string, params: unknown): CloseKind {
  switch (surfaceKindFromParams(params)) {
    case 'terminal': return isTrivialShell(id) ? 'trivial' : 'confirm';
    // A closed tab reopens at its URL, reloaded.
    case 'browser': return resolveRenderMode(params) === 'iframe' ? 'reopenable' : 'confirm';
    case 'tool': return isReopenableBuiltin(id, params) ? 'reopenable' : 'confirm';
  }
}
