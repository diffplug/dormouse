import { getPlatform } from './platform';
import { registry } from './terminal-store';
import { disposeSession, getOrCreateTerminal, parkElement, setPendingShellOpts } from './terminal-lifecycle';
import { addPendingKill } from './pending-kills';
import { isDelayedKillEnabled } from './labs-settings';
import type { WorkspaceId } from './session-types';
import { getDefaultShellOpts } from './shell-defaults';
import { getInheritableCwd, getTerminalPaneState, isPaneOscDriven, seedLaunchedCommand } from './terminal-state-store';
import { DEFAULT_HELPER_COMMAND, type HelperIdentity } from './terminal-context-types';

export type HelperStatus = 'waiting' | 'running' | 'completed' | 'preserved' | 'off' | 'unsupported' | 'exited';
export interface HelperTerminal extends HelperIdentity { id: string; status: HelperStatus; promoting?: boolean; timer?: ReturnType<typeof setInterval> }
const STATUS_POLL_MS = 100;
const READINESS_TIMEOUT_MS = 8000;
const WORK_INSPECTION_MS = 2000;
const helpers = new Map<string, HelperTerminal>();
const pending = new Map<string, Promise<HelperTerminal>>();
const visibleParents = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
export function notifyHelpers(): void { revision++; for (const listener of listeners) listener(); }
export const subscribeHelpers = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const helperRevision = () => revision;
export const getHelper = (parentId: string) => helpers.get(parentId);

export function setHelperVisible(parentId: string, visible: boolean): void {
  if (visible) visibleParents.add(parentId);
  else visibleParents.delete(parentId);
  const helper = helpers.get(parentId);
  if (!helper) return;
  if (visible) watchHelper(helper);
  else {
    clearInterval(helper.timer);
    // An old idle result cannot prove a hidden helper is still idle at quit.
    const entry = registry.get(helper.id);
    if (entry) entry.helperBusy = undefined;
  }
}

const atPrompt = (id: string) => {
  const state = getTerminalPaneState(id);
  return (state.activity.kind === 'prompt' || state.activity.kind === 'editing') && !state.currentCommand;
};

/** One poll per helper advances its status and, once settled, refreshes the host work inspection. */
function watchHelper(helper: HelperTerminal, launchCwd?: string): void {
  clearInterval(helper.timer);
  if (!visibleParents.has(helper.parentId) || helper.promoting) return;
  const started = Date.now();
  let lastInspection = 0;
  let inspecting = false;
  helper.timer = setInterval(() => {
    const entry = registry.get(helper.id);
    if (!entry || helpers.get(helper.parentId) !== helper) { clearInterval(helper.timer); return; }
    let status = helper.status;
    if (entry.exited) status = 'exited';
    else if (!entry.untouched) status = 'preserved';
    else if (helper.status === 'waiting') {
      if (isPaneOscDriven(helper.id) && atPrompt(helper.id)) {
        status = 'running';
        seedLaunchedCommand(helper.id, helper.command, launchCwd);
        getPlatform().writePty(helper.id, `${helper.command}\r`);
      } else if (Date.now() - started >= READINESS_TIMEOUT_MS) status = 'unsupported';
    } else if (helper.status === 'running' && atPrompt(helper.id)) status = 'completed';
    if (status !== helper.status) { helper.status = status; notifyHelpers(); }
    if (status === 'exited') { clearInterval(helper.timer); return; }
    if (status === 'waiting' || status === 'running' || inspecting || Date.now() - lastInspection < WORK_INSPECTION_MS) return;
    inspecting = true; lastInspection = Date.now();
    void helperHasWork(helper).catch(() => { entry.helperBusy = true; }).finally(() => {
      inspecting = false;
      if (!visibleParents.has(helper.parentId)) entry.helperBusy = undefined;
    });
  }, STATUS_POLL_MS);
}

/** Recover a live helper PTY whose source also survived. Replays do not prove
 *  absence of user input, so recovery always disarms autorun. */
export function restoreHelper(id: string, identity: HelperIdentity): void {
  parkElement(id);
  installHelper({ ...identity, id, status: 'preserved' });
}

function installHelper(helper: HelperTerminal): void {
  helpers.set(helper.parentId, helper);
  watchHelper(helper);
  notifyHelpers();
}

/** A live helper PTY whose source did not survive becomes an ordinary Session:
 *  the host stops treating it as auxiliary, on the same handshake as promotion. */
export function adoptOrphanedHelper(id: string): void {
  void getPlatform().terminalContext?.({ op: 'promote', id });
}

export async function helperHasWork(helper: HelperTerminal): Promise<boolean> {
  const entry = registry.get(helper.id);
  if (helper.promoting) return true;
  if (!entry || entry.exited) return false;
  if (getTerminalPaneState(helper.id).currentCommand) { entry.helperBusy = true; return true; }
  const inputVersion = entry.inputVersion;
  const info = await getPlatform().terminalContext?.({ op: 'info', id: helper.id });
  entry.helperBusy = info?.busy !== false || entry.inputVersion !== inputVersion || Boolean(helper.promoting) || !!getTerminalPaneState(helper.id).currentCommand;
  return entry.helperBusy;
}

export function forgetHelper(parentId: string): void {
  const helper = helpers.get(parentId);
  if (!helper) return;
  clearInterval(helper.timer);
  helpers.delete(parentId);
  notifyHelpers();
}

export function disposeHelper(parentId: string): void {
  const helper = helpers.get(parentId);
  if (!helper) return;
  if (helper.promoting) throw new Error('Helper promotion is in progress');
  forgetHelper(parentId);
  disposeSession(helper.id);
}

/**
 * Take the parent's helper off it without ending its Session — a Reset made a
 * pending kill (`docs/specs/reopen.md`). The caller owns the returned helper:
 * {@link reattachHelper} puts it back, `disposeSession` ends it.
 */
export function detachHelper(parentId: string): HelperTerminal | undefined {
  const helper = helpers.get(parentId);
  if (!helper || helper.promoting) return undefined;
  forgetHelper(parentId);
  return helper;
}

/** Put a detached helper back on its parent, ending the one that replaced it.
 *  False when the parent has closed, or the replacement holds anything a
 *  discard would lose: user input, a running command, a promotion. */
export function reattachHelper(helper: HelperTerminal): boolean {
  const { parentId } = helper;
  if (!parentIsOpen(parentId) || !registry.has(helper.id)) return false;
  const replacement = helpers.get(parentId);
  const entry = replacement && registry.get(replacement.id);
  if (replacement && (replacement.promoting || entry?.untouched === false || getTerminalPaneState(replacement.id).currentCommand)) return false;
  if (replacement) disposeHelper(parentId);
  installHelper(helper);
  return true;
}

/**
 * Discard a parent's helper for a fresh one. Under Labs the old one is a
 * pending kill instead, which a restore puts back in place of the fresh one
 * (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
 */
export function resetHelper(parentId: string, parent: { workspaceId: WorkspaceId; title: string; ref: string }): void {
  if (!isDelayedKillEnabled()) { disposeHelper(parentId); return; }
  const old = detachHelper(parentId);
  if (!old) return;
  addPendingKill({ kind: 'helper', id: old.id, workspaceId: parent.workspaceId, ref: parent.ref, surfaceId: old.parentId, title: parent.title, label: 'Helper' }, {
    // A closed parent, or a replacement with work of its own, refuses: the old
    // helper stays pending, its countdown untouched, until it finalizes.
    restore: () => reattachHelper(old),
    finalize: () => disposeSession(old.id),
  });
}

/** Parents torn down while their registry entry lingers for the kill fade; a
 *  WeakSet so the mark leaves with the entry. */
const closedParents = new WeakSet<object>();

/** The parent Surface is retiring (kill, renderer swap, shell replacement):
 *  dispose its helper, and refuse an `openHelper` whose host round trip lands
 *  afterwards, which would otherwise spawn a helper PTY nothing can reach. */
export function closeHelperParent(parentId: string): void {
  disposeHelper(parentId);
  const entry = registry.get(parentId);
  if (entry) closedParents.add(entry);
}

function parentIsOpen(parentId: string): boolean {
  const entry = registry.get(parentId);
  return !!entry && !closedParents.has(entry);
}

export async function openHelper(parentId: string): Promise<HelperTerminal> {
  const inFlight = pending.get(parentId);
  if (inFlight) return inFlight;
  const operation = (async () => {
    if (helpers.has(parentId) && !registry.has(helpers.get(parentId)!.id)) forgetHelper(parentId);
    const previous = helpers.get(parentId);
    if (previous) {
      const entry = registry.get(previous.id);
      const priorStatus = previous.status;
      if (entry?.exited) previous.status = 'exited';
      else if (!entry?.untouched) previous.status = 'preserved';
      else if (previous.status === 'running' && atPrompt(previous.id)) previous.status = 'completed';
      // The first context render preceded this effect; the next tick would
      // see the already-updated status and have no change left to publish.
      if (previous.status !== priorStatus) notifyHelpers();
      if (!entry?.untouched || (previous.status !== 'completed' && previous.status !== 'off') || await helperHasWork(previous)) return previous;
      // Input or ownership can change during process inspection.
      if (helpers.get(parentId) !== previous || !entry.untouched) return helpers.get(parentId) ?? previous;
      disposeHelper(parentId);
    }
    const platform = getPlatform();
    if (!platform.terminalContext) throw new Error('Helper terminals are unavailable on this host');
    const settings = await platform.terminalContext({ op: 'settings' });
    if (!parentIsOpen(parentId)) throw new Error('The parent terminal has closed');
    const id = `helper-${crypto.randomUUID()}`;
    // One cwd for the spawn and the launched command's record, so a remote parent
    // leaves the helper in the host default rather than claiming the ssh path.
    const cwd = getInheritableCwd(parentId);
    const command = settings.command ?? DEFAULT_HELPER_COMMAND;
    const helper: HelperTerminal = { id, parentId, command, status: command ? 'waiting' : 'off' };
    helpers.set(parentId, helper);
    setPendingShellOpts(id, { ...getDefaultShellOpts(), cwd, helper: { parentId, command } });
    getOrCreateTerminal(id);
    parkElement(id);
    notifyHelpers();
    watchHelper(helper, cwd);
    return helper;
  })();
  pending.set(parentId, operation);
  try { return await operation; } finally { pending.delete(parentId); }
}

/** Hands the helper to the caller for placement: autorun is cancelled and the host stops treating the PTY as auxiliary. */
export async function beginPromotion(parentId: string): Promise<HelperTerminal> {
  const helper = helpers.get(parentId);
  if (!helper) throw new Error('This terminal has no helper');
  if (helper.promoting) throw new Error('Helper promotion is in progress');
  // Cancel launch injection before asynchronous ownership transfer.
  clearInterval(helper.timer);
  helper.promoting = true;
  helper.status = 'preserved';
  const entry = registry.get(helper.id);
  if (entry) entry.untouched = false;
  try { await getPlatform().terminalContext?.({ op: 'promote', id: helper.id }); }
  catch (error) { helper.promoting = false; watchHelper(helper); throw error; }
  return helper;
}

/** Placement failed: the host resumes auxiliary ownership and inspection continues. */
export async function cancelPromotion(parentId: string): Promise<void> {
  const helper = helpers.get(parentId);
  if (!helper) return;
  try {
    await getPlatform().terminalContext?.({ op: 'promote', id: helper.id, restore: { parentId, command: helper.command } });
  } finally {
    helper.promoting = false;
    watchHelper(helper);
  }
}

/** The placed helper is now an ordinary Session. */
export function finishPromotion(parentId: string): void {
  const helper = helpers.get(parentId);
  if (!helper) return;
  const entry = registry.get(helper.id);
  if (entry) { entry.helper = undefined; entry.untouched = false; }
  forgetHelper(parentId);
}
