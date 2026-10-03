/**
 * Reaping (`docs/specs/dor-tool.md` -> Reaping): stop an idle, out-of-sight
 * Tool that declared itself safe to stop, and start it again when it is shown.
 * `useToolReaper` decides when; this module is what a stop and a rehydrate do.
 */
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';
import { parseRenderMode } from 'dor-lib-common/browser-providers';
import { getPlatform, PLATFORM_STRING } from '../../lib/platform';
import { toolReapIdleMsOverride } from '../../lib/feature-flags';
import { getHelper } from '../../lib/helper-terminal';
import { isPendingKillSession } from '../../lib/pending-kills';
import { isToolCommandArgv } from '../../lib/session-types';
import { toolCommandFromParams } from '../../lib/session-save';
import {
  getDefaultShellOpts,
  getLivePersistedAlertState,
  getTerminalPaneState,
  reapTerminal,
  rehydrateTerminal,
  subscribeToTerminalPaneState,
} from '../../lib/terminal-registry';
import { registry } from '../../lib/terminal-store';
import { getToolAnnounce } from '../../lib/tool-announce-store';
import { getToolDirty } from '../../lib/tool-dirty-store';
import {
  beginToolStop,
  endToolStop,
  isToolReaped,
  isToolStopping,
  markToolReaped,
  takeToolReap,
} from '../../lib/tool-reap-store';
import { isToolParams, toolPendingFromParams } from './browser-surface';
import type { LathWallEngine } from './lath-wall-engine';
import { retireToolRun } from './use-tool-serving';

/** How long a Tool must be out of sight and silent before it is reaped. */
const TOOL_REAP_IDLE_MS = 30 * 60_000;
/** How long a stopping Tool has to exit on its own before its PTY is killed. */
export const TOOL_STOP_GRACE_MS = 3_000;
/** After the prompt returns: a payload parsed in the same chunk as the shell's
 *  finish can arrive in the message after it. */
const STOP_SETTLE_MS = 100;

export function toolReapIdleMs(): number {
  return toolReapIdleMsOverride() ?? TOOL_REAP_IDLE_MS;
}

/** Why `id` may not be reaped now, or null when it may. The idle and
 *  out-of-sight conditions, and the Workspace's, are the caller's. */
export function toolReapBlocker(id: string, params: Record<string, unknown> | undefined): string | null {
  if (!isToolParams(params)) return 'not a Tool';
  if (isToolReaped(id) || isToolStopping(id)) return 'already reaped';
  // A pending kill's restore must bring back the same process (docs/specs/reopen.md).
  if (isPendingKillSession(id)) return 'it is a pending kill';
  if (toolPendingFromParams(params)) return 'awaiting approval';
  if (params.toolPreview === true) return 'a preview slot';
  // A popped-out browser is in sight in its own window, Door or not.
  if (parseRenderMode(params.renderMode).presentation === 'popout') return 'its browser is popped out';
  const entry = registry.get(id);
  if (!entry || entry.exited) return 'no live Session';
  const command = toolCommandFromParams(params);
  // Only the designated command's own declaration counts: another command
  // typed into the Tool's shell is not what a rehydrate would start.
  if (!command || getTerminalPaneState(id).currentCommand?.rawCommandLine !== command) return 'its command is not running';
  const announce = getToolAnnounce(id);
  if (announce?.dehydrate !== true) return 'it never declared itself safe to stop';
  if (announce.persist === 'never') return 'it announced persist: never';
  if (getToolDirty(id) === true) return 'it reports unsaved changes';
  if (getHelper(id)) return 'it has an auxiliary helper';
  return null;
}

/** Resolves once `done()` holds after a pane-state change, or at the deadline. */
function waitFor(id: string, done: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeToTerminalPaneState((changed) => {
      if ((changed === undefined || changed === id) && done()) finish();
    });
    if (done()) finish();
  });
}

/**
 * Stop `id` with the graceful-stop signal and kill its PTY: Ctrl+C, then the
 * prompt or the grace, whichever comes first. Keeps the `dehydrate` payload its
 * run emitted on the way out. False when it was not eligible, or went away
 * while stopping.
 */
export async function stopTool(lath: LathWallEngine, id: string): Promise<boolean> {
  if (toolReapBlocker(id, lath.getMeta(id)?.params) !== null) return false;
  const state = getTerminalPaneState(id);
  const cwd = state.currentCommand?.cwdAtStart?.path ?? state.cwd?.path ?? null;
  beginToolStop(id);
  let payload: string | null;
  try {
    // The stop is the host's own doing: never a command-exit ring or a push.
    getPlatform().alertSilenceRun?.(id);
    getPlatform().writePty(id, '\x03');
    await waitFor(id, () => !registry.has(id) || getTerminalPaneState(id).currentCommand === null, TOOL_STOP_GRACE_MS);
    await new Promise(resolve => setTimeout(resolve, STOP_SETTLE_MS));
  } finally {
    payload = endToolStop(id);
  }
  // Closed meanwhile: its closure owns the teardown.
  if (!registry.has(id) || !lath.getMeta(id)) return false;
  const alert = getLivePersistedAlertState(id);
  reapTerminal(id);
  retireToolRun(lath, id);
  markToolReaped(id, { payload, cwd, alert });
  return true;
}

/**
 * Start a reaped Tool again in a fresh shell: its saved command, argv
 * re-quoted for the shell it gets, with the payload in `DORMOUSE_DEHYDRATE`.
 * Answers the
 * command and directory it started, or null when `id` is not reaped or has no
 * command to start.
 */
export function rehydrateTool(lath: LathWallEngine, id: string): { command: string; cwd: string } | null {
  const params = lath.getMeta(id)?.params;
  if (!isToolReaped(id) || !isToolParams(params) || !registry.has(id)) return null;
  const shell = getDefaultShellOpts();
  const command = isToolCommandArgv(params.toolArgv)
    ? buildShellCommandForKind(shellCommandKind(shell?.shell, PLATFORM_STRING), params.toolArgv)
    : toolCommandFromParams(params);
  if (!command) return null;
  const record = takeToolReap(id);
  // Serving frames only a port of the designated command (Serving).
  if (command !== params.command) lath.store.updateParams(id, { command });
  const fallbackCwd = typeof params.cwd === 'string' ? params.cwd : null;
  const cwd = record?.cwd ?? getTerminalPaneState(id).cwd?.path ?? fallbackCwd;
  rehydrateTerminal(id, { cwd, shell: shell?.shell, args: shell?.args, command, dehydrate: record?.payload, alert: record?.alert });
  return { command, cwd: getTerminalPaneState(id).cwd?.path ?? cwd ?? '' };
}
