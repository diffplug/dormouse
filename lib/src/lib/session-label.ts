import { getActivitySnapshot } from './session-activity-store';
import { buildAppTitleResolver, deriveSurfaceLabel, DEFAULT_IDLE_TITLE } from './terminal-state';
import { getTerminalPaneStateSnapshot } from './terminal-state-store';

/**
 * The concise display label for one Surface id — `pnpm dev`, a cwd basename, an
 * app title — mirroring what `buildDorSurfaces` and the pane header show.
 * Works for visible Panes and minimized Doors alike; both keep their terminal
 * state.
 *
 * `deriveSurfaceLabel` in `terminal-state.ts` is the pure derivation. This is
 * the id-keyed wrapper over the live stores, kept in one place because every
 * caller needs the same "an idle pane is called `terminal`" fallback — and one
 * of them (spoken alarms) may only ever say a derived label, never terminal
 * output (`docs/specs/alert.md` -> Spoken alarms).
 */
export function deriveSessionLabel(id: string, fallbackTitle: string | null = null): string {
  const states = getTerminalPaneStateSnapshot();
  const state = states.get(id);
  if (state) {
    const appTitleForPane = buildAppTitleResolver(states, getActivitySnapshot());
    const primary = deriveSurfaceLabel(state, [state], appTitleForPane, fallbackTitle);
    if (primary && primary !== DEFAULT_IDLE_TITLE) return primary;
  }
  return fallbackTitle?.trim() || 'terminal';
}
