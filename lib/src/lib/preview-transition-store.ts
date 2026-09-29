/**
 * A preview slot switch in progress, per leaf: the ghost of what the slot last
 * fully showed, held until the view a retarget committed is ready, and the
 * browser generation that keys its layers (`docs/specs/dor-tool.md` ->
 * "Switching the slot"). Renderer-global and volatile: never persisted,
 * cleared on Session disposal.
 *
 * Every `dor open --preview` owns the transition through a token; a newer one
 * takes it over, keeping the ghost, so an older request's end is a no-op.
 */

/** End a committed switch regardless after this long. */
export const PREVIEW_READY_FALLBACK_MS = 3_000;
/** The new view's fade-in over the ghost. */
export const PREVIEW_REVEAL_MS = 120;

export interface GhostRect { left: number; top: number; width: number; height: number }

/** What stands in for the slot's last fully shown content. None reloads or
 *  reconnects. */
export type PreviewGhost =
  /** The iframe browser layer of `generation`, kept mounted on these params. */
  | { kind: 'layer'; generation: number; params: Readonly<Record<string, unknown>> }
  /** A copy of a screencast canvas's frame, at its place in the browser half;
   *  null when it had no frame to take. */
  | { kind: 'image'; frame: { canvas: HTMLCanvasElement; rect: GhostRect } | null }
  /** The terminal half itself. */
  | { kind: 'terminal' };

/** `holding` until the owner's retarget commits, `committed` until its view is
 *  ready, then `revealing` while that view fades in. */
export type PreviewTransitionPhase = 'holding' | 'committed' | 'revealing';

export interface PreviewTransition {
  readonly token: number;
  readonly ghost: PreviewGhost;
  /** The name a committed retarget gave a terminal face's header; null keeps
   *  the held one. A serving Tool's header names it from its params. */
  readonly label: string | null;
  readonly phase: PreviewTransitionPhase;
  /** Motion resolves instantly: a static blur and no fade. */
  readonly instant: boolean;
}

export interface PreviewSlotView {
  /** Changes only when a switch commits, never on navigation. */
  readonly generation: number;
  readonly transition: PreviewTransition | null;
}

interface Entry {
  view: PreviewSlotView;
  /** The committed generation whose view is not ready yet, and its armed
   *  signals. A takeover keeps them: the view still shows once ready. */
  awaiting?: { generation: number; timer: ReturnType<typeof setTimeout>; stopWatch?: () => void };
  /** A committed view became ready while a newer owner held the switch. */
  ready?: boolean;
  fade?: ReturnType<typeof setTimeout>;
}

const EMPTY: PreviewSlotView = { generation: 0, transition: null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let nextToken = 1;

function emit(): void {
  for (const listener of listeners) listener();
}

function stopAwaiting(entry: Entry): void {
  if (!entry.awaiting) return;
  clearTimeout(entry.awaiting.timer);
  entry.awaiting.stopWatch?.();
  entry.awaiting = undefined;
}

function stop(entry: Entry): void {
  stopAwaiting(entry);
  clearTimeout(entry.fade);
  entry.fade = undefined;
  entry.ready = false;
}

function write(id: string, view: PreviewSlotView): void {
  const entry = entries.get(id);
  if (entry) entry.view = view;
  else entries.set(id, { view });
  emit();
}

function owned(id: string, token: number): { entry: Entry; transition: PreviewTransition } | null {
  const entry = entries.get(id);
  const transition = entry?.view.transition;
  return entry && transition?.token === token ? { entry, transition } : null;
}

export function getPreviewSlotView(id: string): PreviewSlotView {
  return entries.get(id)?.view ?? EMPTY;
}

export function subscribeToPreviewTransitions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Start a switch on `id`, or take over the one in progress — keeping its ghost,
 * which is the last fully shown content, rather than capturing a half-switched
 * pane, and a committed view's ready signals, which the new owner's end falls
 * back to. Returns the new owner's token, or null when `capture` finds nothing
 * to hold.
 */
export function beginPreviewTransition(
  id: string,
  capture: () => PreviewGhost | null,
  instant: boolean,
): number | null {
  const entry = entries.get(id);
  const current = entry?.view.transition;
  if (entry && current) {
    clearTimeout(entry.fade);
    entry.fade = undefined;
    // A view fading in was ready.
    if (current.phase === 'revealing') entry.ready = true;
    const token = nextToken++;
    write(id, { ...entry.view, transition: { ...current, token, phase: 'holding' } });
    return token;
  }
  const ghost = capture();
  if (!ghost) return null;
  const token = nextToken++;
  write(id, {
    generation: entry?.view.generation ?? 0,
    transition: { token, ghost, label: null, phase: 'holding', instant },
  });
  return token;
}

/**
 * The owner's retarget committed: a new browser generation, a terminal face
 * header's new name, and the ready signals armed — the new layer's (`previewLayerReady`),
 * the committer's own (`arm`, which returns its stop), and the fallback. False,
 * doing nothing, for a request that no longer owns it.
 */
export function commitPreviewTransition(
  id: string,
  token: number,
  commit: { label: string | null; arm: (ready: () => void) => () => void },
): boolean {
  const current = owned(id, token);
  if (!current) return false;
  const { entry, transition } = current;
  stop(entry);
  const generation = entry.view.generation + 1;
  write(id, {
    generation,
    transition: { ...transition, phase: 'committed', label: commit.label ?? transition.label },
  });
  const ready = () => viewReady(id, generation);
  entry.awaiting = { generation, timer: setTimeout(ready, PREVIEW_READY_FALLBACK_MS) };
  const stopWatch = commit.arm(ready);
  if (entry.awaiting?.generation === generation) entry.awaiting.stopWatch = stopWatch;
  else stopWatch();
  return true;
}

/** A browser layer of `generation` has painted its first document or frame. */
export function previewLayerReady(id: string, generation: number): void {
  viewReady(id, generation);
}

/** The view committed as `generation` is ready: it shows now, or, while a
 *  newer owner holds the switch, once that owner ends without committing. */
function viewReady(id: string, generation: number): void {
  const entry = entries.get(id);
  const transition = entry?.view.transition;
  if (!entry || !transition || entry.awaiting?.generation !== generation) return;
  stopAwaiting(entry);
  if (transition.phase === 'committed') reveal(id, entry);
  else entry.ready = true;
}

function reveal(id: string, entry: Entry): void {
  const transition = entry.view.transition;
  entry.ready = false;
  if (!transition || transition.instant) {
    write(id, { ...entry.view, transition: null });
    return;
  }
  write(id, { ...entry.view, transition: { ...transition, phase: 'revealing' } });
  entry.fade = setTimeout(() => {
    entry.fade = undefined;
    if (owned(id, transition.token)) write(id, { ...entry.view, transition: null });
  }, PREVIEW_REVEAL_MS);
}

/** The owner's request ended without committing. A switch it took over that
 *  had committed goes on: waiting for that view, or showing it now if ready.
 *  Otherwise it unblurs now. A committed switch, or one a newer request took
 *  over, ends nothing. */
export function endPreviewTransition(id: string, token: number): void {
  const current = owned(id, token);
  if (current?.transition.phase !== 'holding') return;
  const { entry, transition } = current;
  if (entry.awaiting) write(id, { ...entry.view, transition: { ...transition, phase: 'committed' } });
  else if (entry.ready) reveal(id, entry);
  else write(id, { ...entry.view, transition: null });
}

/** Forget a leaf whose Session is gone. */
export function clearPreviewTransition(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  stop(entry);
  entries.delete(id);
  emit();
}

/** Test seam. */
export function resetPreviewTransitions(): void {
  for (const entry of entries.values()) stop(entry);
  entries.clear();
  emit();
}
