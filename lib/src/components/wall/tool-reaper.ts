/**
 * Reaping (`docs/specs/dor-tool.md` -> Reaping): stop an idle, out-of-sight
 * Tool that declared itself safe to stop, and start it again when it is shown.
 * `useToolReaper` decides when; this module is what a stop and a rehydrate do.
 */
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';
import { getPlatform, PLATFORM_STRING } from '../../lib/platform';
import { getHelper } from '../../lib/helper-terminal';
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
export const TOOL_REAP_IDLE_MS = 30 * 60_000;
/** `localStorage` key overriding `TOOL_REAP_IDLE_MS`, in ms: testing only. */
export const TOOL_REAP_IDLE_OVERRIDE_KEY = 'dormouse.debug.toolReapIdleMs';
/** How long a stopping Tool has to exit on its own before its PTY is killed. */
export const TOOL_STOP_GRACE_MS = 3_000;
/** After the prompt returns: a payload parsed in the same chunk as the shell's
 *  finish can arrive in the message after it. */
const STOP_SETTLE_MS = 100;
const POLL_MS = 50;
/** How long a dehydrated run may take to fail before its bare retry is moot. */
const RETRY_WINDOW_MS = 120_000;

export function toolReapIdleMs(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(TOOL_REAP_IDLE_OVERRIDE_KEY) ?? NaN);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // No storage in this context: the default.
  }
  return TOOL_REAP_IDLE_MS;
}

/** Why `id` may not be reaped now, or null when it may. The idle and
 *  out-of-sight conditions, and the Workspace's, are the caller's. */
export function toolReapBlocker(id: string, params: Record<string, unknown> | undefined): string | null {
  if (!isToolParams(params)) return 'not a Tool';
  if (isToolReaped(id) || isToolStopping(id)) return 'already reaped';
  if (toolPendingFromParams(params)) return 'awaiting approval';
  if (params.toolPreview === true) return 'a preview slot';
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

function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (done() || Date.now() >= deadline) resolve();
      else setTimeout(tick, POLL_MS);
    };
    tick();
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
    getPlatform().writePty(id, '\x03');
    await waitFor(() => !registry.has(id) || getTerminalPaneState(id).currentCommand === null, TOOL_STOP_GRACE_MS);
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
 * A dehydrated run that fails before it announces is typed once more, without
 * the payload, which the shell integration has unset by then. False when `id`
 * is not reaped or has no command to start.
 */
export function rehydrateTool(lath: LathWallEngine, id: string): boolean {
  const params = lath.getMeta(id)?.params;
  if (!isToolReaped(id) || !isToolParams(params)) return false;
  const shell = getDefaultShellOpts();
  const command = isToolCommandArgv(params.toolArgv)
    ? buildShellCommandForKind(shellCommandKind(shell?.shell, PLATFORM_STRING), params.toolArgv)
    : toolCommandFromParams(params);
  if (!command) return false;
  const record = takeToolReap(id);
  // Serving frames only a port of the designated command (Serving).
  if (command !== params.command) lath.store.updateParams(id, { command });
  const fallbackCwd = typeof params.cwd === 'string' ? params.cwd : null;
  const cwd = record?.cwd ?? getTerminalPaneState(id).cwd?.path ?? fallbackCwd;
  rehydrateTerminal(id, {
    cwd,
    shell: shell?.shell,
    args: shell?.args,
    command,
    dehydrate: record?.payload ?? null,
    alert: record?.alert ?? null,
  });
  if (record?.payload) retryWithoutPayload(id, command);
  return true;
}

/** The bare-args tier: once, when the dehydrated run exits non-zero having
 *  announced nothing. */
function retryWithoutPayload(id: string, command: string): void {
  let runId: string | null = null;
  const stop = () => { clearTimeout(timer); unsubscribe(); };
  const timer = setTimeout(stop, RETRY_WINDOW_MS);
  const unsubscribe = subscribeToTerminalPaneState((changed) => {
    if (changed !== undefined && changed !== id) return;
    const entry = registry.get(id);
    if (!entry || entry.exited) { stop(); return; }
    const state = getTerminalPaneState(id);
    if (runId === null) {
      // The launch seeds a run of its own that the first prompt ends: only
      // the one the shell reports is the Tool's.
      const run = state.currentCommand;
      if (run?.rawCommandLine === command && run.source !== 'user_input') runId = run.id;
      return;
    }
    if (state.currentCommand !== null || state.lastCommand?.id !== runId) return;
    stop();
    const exitCode = state.lastCommand.exitCode;
    if (exitCode !== undefined && exitCode !== 0 && getToolAnnounce(id) === null) {
      getPlatform().writePty(id, `${command}\r`);
    }
  });
}
