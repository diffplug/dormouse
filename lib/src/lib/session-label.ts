import { getActivitySnapshot } from './session-activity-store';
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

/** The label a Surface's Door and pane header show for it, `<idle>` included —
 *  the Door's own derivation (`doorProps` in `Baseboard.tsx`) over the live
 *  stores — for text that must name what is on screen, such as a Workspace tab
 *  pill's tooltip. {@link deriveSessionLabel} is the spoken form. */
export function deriveDisplayedSessionLabel(id: string, fallbackTitle: string): string {
  const states = getTerminalPaneStateSnapshot();
  return deriveSurfaceLabel(states.get(id) ?? createTerminalPaneState(), buildAppTitleResolver(states, getActivitySnapshot()), fallbackTitle);
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
