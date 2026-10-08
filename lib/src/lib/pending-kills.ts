import type { WorkspaceId } from './session-types';
import { getWorkspaceSurfacesSnapshot } from './workspace-surfaces';

/**
 * Pending kills (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill"): a
 * close that would have confirmed instead leaves the layout at once while its
 * process lives on, until a countdown finalizes it or the user restores it.
 * One store per Window; the owner of each entry — a Wall, the Workspace
 * lifecycle, a helper — supplies how to restore and finalize it.
 */

/** How long a pending kill lives before it finalizes. */
export const PENDING_KILL_MS = 10_000;

export type PendingKillKind = 'surface' | 'workspace' | 'helper';

export interface PendingKill {
  kind: PendingKillKind;
  /** The Surface's id (a helper's own Session id), or the Workspace's. */
  id: string;
  /** The Workspace it belongs to, or is. */
  workspaceId: WorkspaceId;
  /** The public Surface a restore brings back: a helper's parent. */
  surfaceId?: string;
  title: string;
  /** What it is, as the overlay names it. */
  label: string;
  /** When it went pending: Reopen takes the newest across these and its records. */
  startedAt: number;
  /** Time left while paused; otherwise the time left at `resumedAt`. */
  remainingMs: number;
  /** When the countdown last resumed, or null while the pointer holds it. */
  resumedAt: number | null;
}

export interface PendingKillActions {
  /** Bring it back as it was; `focus` brings it into view, as a gesture does.
   *  `false` refuses — it cannot come back now — leaving it pending as it was. */
  restore(focus: boolean): boolean | void;
  /** End it through today's kill path, settling once it has. `teardown` is a
   *  quit or window close, where nothing may come back instead. */
  finalize(teardown: boolean): void | Promise<void>;
}

type Entry = { kill: PendingKill; actions: PendingKillActions };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: readonly PendingKill[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function publish(): void {
  snapshot = [...entries.values()].map(entry => entry.kill).sort((a, b) => b.startedAt - a.startedAt);
  for (const listener of listeners) listener();
  arm();
}

function timeLeft(kill: PendingKill, now: number): number {
  return kill.resumedAt === null ? kill.remainingMs : kill.remainingMs - (now - kill.resumedAt);
}

/** One timer, for the soonest running countdown. */
function arm(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  let soonest = Infinity;
  for (const { kill } of entries.values()) {
    if (kill.resumedAt !== null) soonest = Math.min(soonest, timeLeft(kill, now));
  }
  if (soonest === Infinity) return;
  timer = setTimeout(expire, Math.max(0, soonest));
}

function expire(): void {
  timer = null;
  const now = Date.now();
  const due = [...entries.entries()].filter(([, { kill }]) => kill.resumedAt !== null && timeLeft(kill, now) <= 0);
  for (const [key] of due) finalizePendingKill(key);
  // Each finalize re-arms; a timer that fired early has nothing due yet.
  if (due.length === 0) arm();
}

export function pendingKillKey(kind: PendingKillKind, id: string): string {
  return `${kind}:${id}`;
}

/** Start a pending kill; its countdown runs at once. */
export function addPendingKill(
  kill: Omit<PendingKill, 'startedAt' | 'remainingMs' | 'resumedAt'>,
  actions: PendingKillActions,
): void {
  const now = Date.now();
  entries.set(pendingKillKey(kill.kind, kill.id), {
    kill: { ...kill, startedAt: now, remainingMs: PENDING_KILL_MS, resumedAt: now },
    actions,
  });
  publish();
}

/** Take an entry out of the store and run one of its actions. */
function settle(key: string, run: (actions: PendingKillActions) => void): boolean {
  const entry = entries.get(key);
  if (!entry) return false;
  entries.delete(key);
  publish();
  run(entry.actions);
  return true;
}

/** Restore one pending kill; false when there is none, or it refused and
 *  stays pending with its countdown untouched. */
export function restorePendingKill(key: string, focus = true): boolean {
  const entry = entries.get(key);
  if (!entry || entry.actions.restore(focus) === false) return false;
  if (entries.get(key) === entry) {
    entries.delete(key);
    publish();
  }
  return true;
}

export function finalizePendingKill(key: string): boolean {
  return settle(key, actions => { void runFinalize(actions, false); });
}

/** One finalize, its failure logged rather than stopping its caller. */
async function runFinalize(actions: PendingKillActions, teardown: boolean): Promise<void> {
  try {
    await actions.finalize(teardown);
  } catch (error) {
    console.warn('[pending-kill] finalize failed', error);
  }
}

/** Finalize every pending kill `which` keeps, settling once all have: a
 *  Workspace leaving, or — every one, as `teardown` — a quit or window close. */
export async function finalizePendingKills(
  which: (kill: PendingKill) => boolean = () => true,
  { teardown = false }: { teardown?: boolean } = {},
): Promise<void> {
  const due = [...entries.entries()].filter(([, { kill }]) => which(kill));
  for (const [key] of due) entries.delete(key);
  if (due.length) publish();
  await Promise.all(due.map(([, { actions }]) => runFinalize(actions, teardown)));
}

/** Hold or release one countdown, as the pointer over its entry does. */
export function holdPendingKill(key: string, held: boolean): void {
  const entry = entries.get(key);
  if (!entry || (entry.kill.resumedAt === null) === held) return;
  const now = Date.now();
  entry.kill = held
    ? { ...entry.kill, remainingMs: Math.max(0, timeLeft(entry.kill, now)), resumedAt: null }
    : { ...entry.kill, resumedAt: now };
  publish();
}

/** Newest first. */
export function getPendingKills(): readonly PendingKill[] {
  return snapshot;
}

export function subscribeToPendingKills(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingKill(kind: PendingKillKind, id: string): PendingKill | null {
  return entries.get(pendingKillKey(kind, id))?.kill ?? null;
}

/** Whether this Session is out of the user's sight on its way to a kill: a
 *  pending Surface or helper, or a member of a pending Workspace. Hidden from
 *  Clients and silenced (`docs/specs/reopen.md`). */
export function isPendingKillSession(id: string): boolean {
  return entries.size > 0 && pendingKillSessionIds().includes(id);
}

/** Every Session a pending kill keeps alive: its Surface or helper, or every
 *  member of its Workspace. */
export function pendingKillSessionIds(): string[] {
  if (entries.size === 0) return [];
  const membership = getWorkspaceSurfacesSnapshot();
  return snapshot.flatMap(kill => kill.kind === 'workspace' ? membership.get(kill.id) ?? [] : [kill.id]);
}

/** A pending kill in `workspaceId` is this Wall's own, whatever its kind but a Workspace's. */
export function isOwnPendingKill(kill: PendingKill, workspaceId: WorkspaceId): boolean {
  return kill.kind !== 'workspace' && kill.workspaceId === workspaceId;
}

/** Why a `dor` Surface target naming `id` names nothing: a pending kill. */
export function pendingSurfaceRefusal(target: string, id: string): string | null {
  return getPendingKill('surface', id) ? `surface '${target}' is a pending kill` : null;
}

/** How far through its countdown a kill is, 0 to 1. */
export function pendingKillProgress(kill: PendingKill, now = Date.now()): number {
  return Math.min(1, Math.max(0, 1 - timeLeft(kill, now) / PENDING_KILL_MS));
}

/** @internal */
export function _resetPendingKillsForTesting(): void {
  entries.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  snapshot = [];
}
