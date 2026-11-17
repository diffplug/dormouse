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
import type { AuxIdentity } from './terminal-context-types';

export interface AuxTerminal extends AuxIdentity { id: string; promoting?: boolean; timer?: ReturnType<typeof setInterval> }
const WORK_INSPECTION_MS = 2000;
const auxTerminals = new Map<string, AuxTerminal>();
const pending = new Map<string, Promise<AuxTerminal>>();
const visibleParents = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
export function notifyAuxTerminals(): void { revision++; for (const listener of listeners) listener(); }
export const subscribeAuxTerminals = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const auxRevision = () => revision;
export const getAux = (parentId: string) => auxTerminals.get(parentId);

export function setAuxVisible(parentId: string, visible: boolean): void {
  if (visible) visibleParents.add(parentId);
  else visibleParents.delete(parentId);
  const aux = auxTerminals.get(parentId);
  if (!aux) return;
  // A hidden aux terminal keeps its last idle answer: Dormouse never writes to one,
  // and any input it receives clears the answer (`markSessionTouched`).
  if (visible) watchAux(aux);
  else clearInterval(aux.timer);
}

/** While visible, publishes an aux terminal's exit and refreshes the host work inspection. */
function watchAux(aux: AuxTerminal): void {
  clearInterval(aux.timer);
  if (!visibleParents.has(aux.parentId) || aux.promoting) return;
  let inspecting = false;
  const check = () => {
    const entry = registry.get(aux.id);
    // A replaced aux terminal's watch stops here.
    if (!entry || auxTerminals.get(aux.parentId) !== aux) { clearInterval(aux.timer); return; }
    if (entry.exited) { clearInterval(aux.timer); notifyAuxTerminals(); return; }
    if (inspecting) return;
    inspecting = true;
    void auxHasWork(aux).catch(() => { entry.auxBusy = true; }).finally(() => { inspecting = false; });
  };
  aux.timer = setInterval(check, WORK_INSPECTION_MS);
  check();
}

/** Recover a live aux terminal PTY whose source also survived. */
export function restoreAux(id: string, identity: AuxIdentity): void {
  parkElement(id);
  installAux({ ...identity, id });
}

function installAux(aux: AuxTerminal): void {
  auxTerminals.set(aux.parentId, aux);
  watchAux(aux);
  notifyAuxTerminals();
}

/** A live aux terminal PTY whose source did not survive becomes an ordinary Session:
 *  the host stops treating it as auxiliary, on the same handshake as promotion. */
export function adoptOrphanedAux(id: string): void {
  void getPlatform().terminalContext?.({ op: 'promote', id });
}

export async function auxHasWork(aux: AuxTerminal): Promise<boolean> {
  const entry = registry.get(aux.id);
  if (aux.promoting) return true;
  if (!entry || entry.exited) return false;
  if (getTerminalPaneState(aux.id).currentCommand) { entry.auxBusy = true; return true; }
  const inputVersion = entry.inputVersion;
  const info = await getPlatform().terminalContext?.({ op: 'info', id: aux.id });
  entry.auxBusy = info?.busy !== false || entry.inputVersion !== inputVersion || Boolean(aux.promoting) || !!getTerminalPaneState(aux.id).currentCommand;
  return entry.auxBusy;
}

export function forgetAux(parentId: string): void {
  const aux = auxTerminals.get(parentId);
  if (!aux) return;
  clearInterval(aux.timer);
  auxTerminals.delete(parentId);
  notifyAuxTerminals();
}

export function disposeAux(parentId: string): void {
  const aux = auxTerminals.get(parentId);
  if (!aux) return;
  if (aux.promoting) throw new Error('Aux terminal promotion is in progress');
  forgetAux(parentId);
  disposeSession(aux.id);
}

/**
 * Take the parent's aux terminal off it without ending its Session — a Reset made a
 * pending kill (`docs/specs/reopen.md`). The caller owns the returned aux terminal:
 * {@link reattachAux} puts it back, `disposeSession` ends it. The host still
 * counts it as the parent's one aux terminal until {@link releaseHostAux}.
 */
export function detachAux(parentId: string): AuxTerminal | undefined {
  const aux = auxTerminals.get(parentId);
  if (!aux || aux.promoting) return undefined;
  forgetAux(parentId);
  return aux;
}

/** The host owns one aux terminal per parent and refuses a second's spawn: a
 *  detached aux terminal stops counting there, on the handshake promotion uses. */
function releaseHostAux(id: string): Promise<unknown> | undefined {
  return getPlatform().terminalContext?.({ op: 'promote', id });
}

/** Put a detached aux terminal back on its parent, ending the one that replaced it.
 *  False when the parent has closed, or the replacement holds anything a
 *  discard would lose: user input, a running command, a promotion. The host
 *  hears it in order — the replacement's claim released, the old one's
 *  restored, then the replacement killed — so its one-aux-terminal rule never sees
 *  two owners. */
export function reattachAux(aux: AuxTerminal): boolean {
  const { parentId } = aux;
  if (auxTransferPending(parentId) || !parentIsOpen(parentId) || !registry.has(aux.id)) return false;
  const replacement = auxTerminals.get(parentId);
  const entry = replacement && registry.get(replacement.id);
  if (replacement && (replacement.promoting || entry?.untouched === false || getTerminalPaneState(replacement.id).currentCommand)) return false;
  if (replacement) forgetAux(parentId);
  installAux(aux);
  void (async () => {
    try {
      if (replacement) await releaseHostAux(replacement.id);
      await getPlatform().terminalContext?.({ op: 'promote', id: aux.id, restore: { parentId } });
    } catch (error) {
      console.warn('[aux terminal] the host refused the restored aux terminal', error);
    } finally {
      if (replacement) disposeSession(replacement.id);
    }
  })();
  return true;
}

/**
 * Discard a parent's aux terminal for a fresh one. Under Labs the old one is a
 * pending kill instead, which a restore puts back in place of the fresh one
 * (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
 */
export async function resetAux(parentId: string, parent: { workspaceId: WorkspaceId; title: string }): Promise<void> {
  requireAuxMutable(parentId);
  if (!isDelayedKillEnabled()) { disposeAux(parentId); return; }
  const old = detachAux(parentId);
  if (!old) return;
  addPendingKill({ kind: 'aux', id: old.id, workspaceId: parent.workspaceId, surfaceId: old.parentId, title: parent.title, label: 'Aux terminal' }, {
    // A closed parent, or a replacement with work of its own, refuses: the old
    // aux terminal stays pending, its countdown untouched, until it finalizes.
    restore: () => reattachAux(old),
    finalize: () => disposeSession(old.id),
  });
  // Before the fresh aux terminal spawns, which the host would otherwise refuse;
  // after the pending kill, so a failed release still finalizes the old one.
  await releaseHostAux(old.id);
}

/** Parents torn down while their registry entry lingers for the kill fade; a
 *  WeakSet so the mark leaves with the entry. */
const closedParents = new WeakSet<object>();

/** The parent Surface is retiring (kill, shell replacement):
 *  dispose its aux terminal, and refuse an `openAux` whose host round trip lands
 *  afterwards, which would otherwise spawn an aux terminal PTY nothing can reach. */
export function closeAuxParent(parentId: string): void {
  disposeAux(parentId);
  const entry = registry.get(parentId);
  if (entry) closedParents.add(entry);
}

function parentIsOpen(parentId: string): boolean {
  const entry = registry.get(parentId);
  return !!entry && !closedParents.has(entry);
}

function auxTransferPending(parentId: string): boolean {
  const owner = wallHandleOwning(parentId);
  return !!owner && isWorkspaceTransferPending(owner.workspaceId);
}

function requireAuxMutable(parentId: string): void {
  if (auxTransferPending(parentId)) throw new Error('Workspace is transferring');
}

/**
 * Where a new aux terminal starts. The source's reported directory is whatever its
 * terminal last printed, so the host's read of the source PTY's process cwd wins;
 * `getCwd` answers null where it cannot read (Windows, a failed read), and a
 * reported directory then opens as a split there would. A remote parent reports
 * nothing here: the aux terminal takes the host default rather than claiming the ssh
 * path, which no terminal output chose.
 */
async function auxDirectory(parentId: string): Promise<string | undefined> {
  const processCwd = await getPlatform().getCwd(parentId).catch(() => null);
  return processCwd || getInheritableCwd(parentId);
}

export async function openAux(parentId: string): Promise<AuxTerminal> {
  requireAuxMutable(parentId);
  // Concurrent openings share one creation, so a source never gets two aux terminals.
  const inFlight = pending.get(parentId);
  if (inFlight) return inFlight;
  const operation = (async () => {
    const previous = auxTerminals.get(parentId);
    if (previous && registry.has(previous.id)) return previous;
    if (previous) forgetAux(parentId);
    const platform = getPlatform();
    if (!platform.terminalContext) throw new Error('Aux terminals are unavailable on this host');
    const cwd = await auxDirectory(parentId);
    requireAuxMutable(parentId);
    if (!parentIsOpen(parentId)) throw new Error('The parent terminal has closed');
    // A restore during the round trip put an aux terminal back; replacing it would
    // orphan its live PTY.
    const restored = auxTerminals.get(parentId);
    if (restored && registry.has(restored.id)) return restored;
    const id = mintSurfaceId();
    const aux: AuxTerminal = { id, parentId };
    auxTerminals.set(parentId, aux);
    setPendingShellOpts(id, { ...getDefaultShellOpts(), cwd, aux: { parentId } });
    getOrCreateTerminal(id);
    // Seed only missing state: shell startup may report a different directory.
    seedTerminalManualCwd(id, cwd);
    parkElement(id);
    notifyAuxTerminals();
    watchAux(aux);
    return aux;
  })();
  pending.set(parentId, operation);
  try { return await operation; } finally { pending.delete(parentId); }
}

/** Hands the aux terminal to the caller for placement: the host stops treating the PTY as auxiliary. */
export async function beginPromotion(parentId: string): Promise<AuxTerminal> {
  requireAuxMutable(parentId);
  const aux = auxTerminals.get(parentId);
  if (!aux) throw new Error('This terminal has no aux terminal');
  if (aux.promoting) throw new Error('Aux terminal promotion is in progress');
  clearInterval(aux.timer);
  aux.promoting = true;
  const entry = registry.get(aux.id);
  if (entry) entry.untouched = false;
  try { await getPlatform().terminalContext?.({ op: 'promote', id: aux.id }); }
  catch (error) { aux.promoting = false; watchAux(aux); throw error; }
  return aux;
}

/** Placement failed: the host resumes auxiliary ownership and inspection continues. */
export async function cancelPromotion(parentId: string): Promise<void> {
  const aux = auxTerminals.get(parentId);
  if (!aux) return;
  try {
    await getPlatform().terminalContext?.({ op: 'promote', id: aux.id, restore: { parentId } });
  } finally {
    aux.promoting = false;
    watchAux(aux);
  }
}

/** The placed aux terminal is now an ordinary Session. */
export function finishPromotion(parentId: string): void {
  const aux = auxTerminals.get(parentId);
  if (!aux) return;
  const entry = registry.get(aux.id);
  if (entry) { entry.aux = undefined; entry.untouched = false; }
  forgetAux(parentId);
}
