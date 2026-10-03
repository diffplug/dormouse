import { getHelper } from '../../lib/helper-terminal';
import { getTerminalPaneState, isUntouched } from '../../lib/terminal-registry';
import { registry } from '../../lib/terminal-store';
import { surfaceKindFromParams } from './browser-surface';

/**
 * What a user close of one Surface does, decided at the close from state
 * already in memory (`docs/specs/reopen.md` → "The rule"):
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
export function isTrivialShell(id: string, params: unknown): boolean {
  if (surfaceKindFromParams(params) !== 'terminal') return false;
  if (!isUntouched(id)) return false;
  if (getTerminalPaneState(id).activity.kind === 'running') return false;
  const helper = getHelper(id);
  if (!helper) return true;
  const helperEntry = registry.get(helper.id);
  return helperEntry?.untouched === true && (helperEntry.exited === true || helperEntry.helperBusy === false);
}

export function closeKind(id: string, params: unknown): CloseKind {
  return isTrivialShell(id, params) ? 'trivial' : 'confirm';
}
