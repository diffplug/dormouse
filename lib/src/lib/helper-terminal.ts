import { wallHandleOwning } from '../components/wall/wall-handles';
import { isWorkspaceTransferPending } from './window-session-aggregator';
import { getPlatform } from './platform';
import { registry } from './terminal-store';
import { mintSurfaceId } from './surface-ids';
import { disposeSession, getOrCreateTerminal, parkElement, setPendingShellOpts } from './terminal-lifecycle';
import { addPendingKill } from './pending-kills';
import { isDelayedKillEnabled } from './labs-settings';
import type { WorkspaceId } from './session-types';
import { getDefaultShellOpts } from './shell-defaults';
import { getInheritableCwd, getTerminalPaneState, seedTerminalManualCwd } from './terminal-state-store';
import type { HelperIdentity } from './terminal-context-types';

export interface HelperTerminal extends HelperIdentity { id: string; promoting?: boolean; timer?: ReturnType<typeof setInterval> }
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
  // A hidden helper keeps its last idle answer: Dormouse never writes to one,
  // and any input it receives clears the answer (`markSessionTouched`).
  if (visible) watchHelper(helper);
  else clearInterval(helper.timer);
}

/** While visible, publishes a helper's exit and refreshes the host work inspection. */
function watchHelper(helper: HelperTerminal): void {
  clearInterval(helper.timer);
  if (!visibleParents.has(helper.parentId) || helper.promoting) return;
  let inspecting = false;
  const check = () => {
    const entry = registry.get(helper.id);
    // A replaced helper's watch stops here.
    if (!entry || helpers.get(helper.parentId) !== helper) { clearInterval(helper.timer); return; }
    if (entry.exited) { clearInterval(helper.timer); notifyHelpers(); return; }
    if (inspecting) return;
    inspecting = true;
    void helperHasWork(helper).catch(() => { entry.helperBusy = true; }).finally(() => { inspecting = false; });
  };
  helper.timer = setInterval(check, WORK_INSPECTION_MS);
  check();
}

/** Recover a live helper PTY whose source also survived. */
export function restoreHelper(id: string, identity: HelperIdentity): void {
  parkElement(id);
  installHelper({ ...identity, id });
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
 * {@link reattachHelper} puts it back, `disposeSession` ends it. The host still
 * counts it as the parent's one helper until {@link releaseHostHelper}.
 */
export function detachHelper(parentId: string): HelperTerminal | undefined {
  const helper = helpers.get(parentId);
  if (!helper || helper.promoting) return undefined;
  forgetHelper(parentId);
  return helper;
}

/** The host owns one helper per parent and refuses a second's spawn: a
 *  detached helper stops counting there, on the handshake promotion uses. */
function releaseHostHelper(id: string): Promise<unknown> | undefined {
  return getPlatform().terminalContext?.({ op: 'promote', id });
}

/** Put a detached helper back on its parent, ending the one that replaced it.
 *  False when the parent has closed, or the replacement holds anything a
 *  discard would lose: user input, a running command, a promotion. The host
 *  hears it in order — the replacement's claim released, the old one's
 *  restored, then the replacement killed — so its one-helper rule never sees
 *  two owners. */
export function reattachHelper(helper: HelperTerminal): boolean {
  const { parentId } = helper;
  if (helperTransferPending(parentId) || !parentIsOpen(parentId) || !registry.has(helper.id)) return false;
  const replacement = helpers.get(parentId);
  const entry = replacement && registry.get(replacement.id);
  if (replacement && (replacement.promoting || entry?.untouched === false || getTerminalPaneState(replacement.id).currentCommand)) return false;
  if (replacement) forgetHelper(parentId);
  installHelper(helper);
  void (async () => {
    try {
      if (replacement) await releaseHostHelper(replacement.id);
      await getPlatform().terminalContext?.({ op: 'promote', id: helper.id, restore: { parentId } });
    } catch (error) {
      console.warn('[helper] the host refused the restored helper', error);
    } finally {
      if (replacement) disposeSession(replacement.id);
    }
  })();
  return true;
}

/**
 * Discard a parent's helper for a fresh one. Under Labs the old one is a
 * pending kill instead, which a restore puts back in place of the fresh one
 * (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
 */
export async function resetHelper(parentId: string, parent: { workspaceId: WorkspaceId; title: string }): Promise<void> {
  requireHelperMutable(parentId);
  if (!isDelayedKillEnabled()) { disposeHelper(parentId); return; }
  const old = detachHelper(parentId);
  if (!old) return;
  addPendingKill({ kind: 'helper', id: old.id, workspaceId: parent.workspaceId, surfaceId: old.parentId, title: parent.title, label: 'Helper' }, {
    // A closed parent, or a replacement with work of its own, refuses: the old
    // helper stays pending, its countdown untouched, until it finalizes.
    restore: () => reattachHelper(old),
    finalize: () => disposeSession(old.id),
  });
  // Before the fresh helper spawns, which the host would otherwise refuse;
  // after the pending kill, so a failed release still finalizes the old one.
  await releaseHostHelper(old.id);
}

/** Parents torn down while their registry entry lingers for the kill fade; a
 *  WeakSet so the mark leaves with the entry. */
const closedParents = new WeakSet<object>();

/** The parent Surface is retiring (kill, shell replacement):
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

function helperTransferPending(parentId: string): boolean {
  const owner = wallHandleOwning(parentId);
  return !!owner && isWorkspaceTransferPending(owner.workspaceId);
}

function requireHelperMutable(parentId: string): void {
  if (helperTransferPending(parentId)) throw new Error('Workspace is transferring');
}

/**
 * Where a new helper starts. The source's reported directory is whatever its
 * terminal last printed, so the host's read of the source PTY's process cwd wins;
 * `getCwd` answers null where it cannot read (Windows, a failed read), and a
 * reported directory then opens as a split there would. A remote parent reports
 * nothing here: the helper takes the host default rather than claiming the ssh
 * path, which no terminal output chose.
 */
async function helperDirectory(parentId: string): Promise<string | undefined> {
  const processCwd = await getPlatform().getCwd(parentId).catch(() => null);
  return processCwd || getInheritableCwd(parentId);
}

export async function openHelper(parentId: string): Promise<HelperTerminal> {
  requireHelperMutable(parentId);
  // Concurrent openings share one creation, so a source never gets two helpers.
  const inFlight = pending.get(parentId);
  if (inFlight) return inFlight;
  const operation = (async () => {
    const previous = helpers.get(parentId);
    if (previous && registry.has(previous.id)) return previous;
    if (previous) forgetHelper(parentId);
    const platform = getPlatform();
    if (!platform.terminalContext) throw new Error('Helper terminals are unavailable on this host');
    const cwd = await helperDirectory(parentId);
    requireHelperMutable(parentId);
    if (!parentIsOpen(parentId)) throw new Error('The parent terminal has closed');
    // A restore during the round trip put a helper back; replacing it would
    // orphan its live PTY.
    const restored = helpers.get(parentId);
    if (restored && registry.has(restored.id)) return restored;
    const id = mintSurfaceId();
    const helper: HelperTerminal = { id, parentId };
    helpers.set(parentId, helper);
    setPendingShellOpts(id, { ...getDefaultShellOpts(), cwd, helper: { parentId } });
    getOrCreateTerminal(id);
    // Seed only missing state: shell startup may report a different directory.
    seedTerminalManualCwd(id, cwd);
    parkElement(id);
    notifyHelpers();
    watchHelper(helper);
    return helper;
  })();
  pending.set(parentId, operation);
  try { return await operation; } finally { pending.delete(parentId); }
}

/** Hands the helper to the caller for placement: the host stops treating the PTY as auxiliary. */
export async function beginPromotion(parentId: string): Promise<HelperTerminal> {
  requireHelperMutable(parentId);
  const helper = helpers.get(parentId);
  if (!helper) throw new Error('This terminal has no helper');
  if (helper.promoting) throw new Error('Helper promotion is in progress');
  clearInterval(helper.timer);
  helper.promoting = true;
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
    await getPlatform().terminalContext?.({ op: 'promote', id: helper.id, restore: { parentId } });
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
