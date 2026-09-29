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
  /** The name a committed retarget gave the header; null keeps the held one. */
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
  timer?: ReturnType<typeof setTimeout>;
  stopWatch?: () => void;
}

const EMPTY: PreviewSlotView = { generation: 0, transition: null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let nextToken = 1;

function emit(): void {
  for (const listener of listeners) listener();
}

function stop(entry: Entry): void {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.stopWatch?.();
  entry.stopWatch = undefined;
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
 * pane. Returns the new owner's token, or null when `capture` finds nothing to
 * hold.
 */
export function beginPreviewTransition(
  id: string,
  capture: () => PreviewGhost | null,
  instant: boolean,
): number | null {
  const entry = entries.get(id);
  const current = entry?.view.transition;
  if (entry && current) {
    stop(entry);
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
 * The owner's retarget committed: a new browser generation, the header's new
 * name, and the ready signals armed — the new layer's (`previewLayerReady`),
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
  write(id, {
    generation: entry.view.generation + 1,
    transition: { ...transition, phase: 'committed', label: commit.label ?? transition.label },
  });
  entry.timer = setTimeout(() => revealPreviewTransition(id, token), PREVIEW_READY_FALLBACK_MS);
  entry.stopWatch = commit.arm(() => revealPreviewTransition(id, token));
  return true;
}

/** A browser layer of `generation` has painted its first document or frame. */
export function previewLayerReady(id: string, generation: number): void {
  const { generation: current, transition } = getPreviewSlotView(id);
  if (transition?.phase === 'committed' && current === generation) revealPreviewTransition(id, transition.token);
}

function revealPreviewTransition(id: string, token: number): void {
  const current = owned(id, token);
  if (!current) return;
  const { entry, transition } = current;
  stop(entry);
  if (transition.instant) {
    write(id, { ...entry.view, transition: null });
    return;
  }
  write(id, { ...entry.view, transition: { ...transition, phase: 'revealing' } });
  entry.timer = setTimeout(() => {
    if (owned(id, token)) write(id, { ...entry.view, transition: null });
  }, PREVIEW_REVEAL_MS);
}

/** The owner's request ended without committing: unblur now. A committed
 *  switch, or one a newer request took over, ends nothing. */
export function endPreviewTransition(id: string, token: number): void {
  const current = owned(id, token);
  if (current?.transition.phase !== 'holding') return;
  stop(current.entry);
  write(id, { ...current.entry.view, transition: null });
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
