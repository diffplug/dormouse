import { hasTerminal, type SurfaceKind } from 'dor/commands/types';
import { getActivitySnapshot, type ActivityState } from './session-activity-store';
import { buildAppTitleResolver, createTerminalPaneState, deriveSurfaceLabel, DEFAULT_IDLE_TITLE, type TerminalPaneState } from './terminal-state';
import { getTerminalPaneStateSnapshot } from './terminal-state-store';

/**
 * The concise display label for one Surface id — `pnpm dev`, a cwd basename, an
 * app title — mirroring what `buildDorSurfaces` and the pane header show.
 * Works for visible Panes and minimized Doors alike; both keep their terminal
 * state.
 *
 * `deriveSurfaceLabel` in `terminal-state.ts` is the pure derivation. This is
 * the id-keyed wrapper over the live stores, kept in one place because every
 * caller needs the same "an idle pane is called `terminal`" fallback. Spoken
 * alarms and pushes intentionally say this exact derived label, including a
 * terminal-supplied OSC 0/2/9 title when it wins the normal display priority
 * (`docs/specs/alert.md` -> Spoken alarms).
 */
export function deriveSessionLabel(id: string, fallbackTitle: string | null = null): string {
  const states = getTerminalPaneStateSnapshot();
  return labelOf(states.get(id), buildAppTitleResolver(states, getActivitySnapshot()), fallbackTitle);
}

/** A {@link deriveSessionLabel} for one caller that asks on every store
 *  emission, such as a hook's snapshot. It derives again only when the id, the
 *  fallback, or that Surface's own terminal state or activity changed — the
 *  only inputs the label reads — so another pane's output costs a lookup. */
export function createSessionLabelMemo(): (id: string, fallbackTitle?: string | null) => string {
  let last: { id: string; state?: TerminalPaneState; activity?: ActivityState; fallbackTitle: string | null; label: string } | null = null;
  return (id, fallbackTitle = null) => {
    const state = getTerminalPaneStateSnapshot().get(id);
    const activities = getActivitySnapshot();
    const activity = activities.get(id);
    if (last?.id === id && last.state === state && last.activity === activity && last.fallbackTitle === fallbackTitle) return last.label;
    const label = labelOf(state, buildAppTitleResolver(new Map(state ? [[id, state]] : []), activities), fallbackTitle);
    last = { id, state, activity, fallbackTitle, label };
    return label;
  };
}

/** The label a Surface's Door and pane header show for it, `<idle>` included:
 *  only a terminal-backed Surface has shell state to derive one from, so
 *  anything else keeps its stored `title`. The Baseboard passes the snapshots it
 *  renders from; a caller naming what is on screen, such as a Workspace tab
 *  pill's tooltip, reads the live stores. {@link deriveSessionLabel} is the
 *  spoken form. */
export function deriveDisplayedSurfaceLabel(
  kind: SurfaceKind,
  id: string,
  title: string,
  states = getTerminalPaneStateSnapshot(),
  appTitleForPane = buildAppTitleResolver(states, getActivitySnapshot()),
): string {
  return hasTerminal(kind) ? deriveSurfaceLabel(states.get(id) ?? createTerminalPaneState(), appTitleForPane, title) : title;
}

/** {@link deriveSessionLabel} for many ids, reading the stores and building the
 *  app-title resolver once rather than once per id. */
export function deriveSessionLabels(ids: Iterable<string>): Map<string, string> {
  const states = getTerminalPaneStateSnapshot();
  const appTitleForPane = buildAppTitleResolver(states, getActivitySnapshot());
  const labels = new Map<string, string>();
  for (const id of ids) labels.set(id, labelOf(states.get(id), appTitleForPane, null));
  return labels;
}

function labelOf(
  state: TerminalPaneState | undefined,
  appTitleForPane: (pane: TerminalPaneState) => string | null,
  fallbackTitle: string | null,
): string {
  if (state) {
    const primary = deriveSurfaceLabel(state, appTitleForPane, fallbackTitle);
    if (primary && primary !== DEFAULT_IDLE_TITLE) return primary;
  }
  return fallbackTitle?.trim() || 'terminal';
}
