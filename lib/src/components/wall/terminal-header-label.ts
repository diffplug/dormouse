import { isHelperSession } from '../../lib/terminal-store';
import { COMMAND_FAIL_GLYPH, deriveHeader, resolveDisplayPrimary, type TerminalPaneState } from '../../lib/terminal-state';

/** The terminal header's label, the failure glyph split off. */
export interface TerminalHeaderLabel {
  primary: string;
  secondary: string | null;
  failed: boolean;
}

/** The Sessions a terminal header's label is disambiguated against: every
 *  non-helper one. */
export function headerPeerStates(terminalStates: ReadonlyMap<string, TerminalPaneState>): TerminalPaneState[] {
  return [...terminalStates].filter(([surfaceId]) => !isHelperSession(surfaceId)).map(([, state]) => state);
}

/** What `TerminalPaneHeader` labels a Session; a preview slot switch captures
 *  it to hold (`docs/specs/layout.md` -> Pane header). */
export function terminalHeaderLabel(
  paneState: TerminalPaneState,
  peerStates: TerminalPaneState[],
  appTitleForPane: (pane: TerminalPaneState) => string | null,
  title: string | undefined,
): TerminalHeaderLabel {
  const derived = deriveHeader(paneState, peerStates.length > 0 ? peerStates : [paneState], { appTitleForPane });
  const displayTitle = resolveDisplayPrimary(derived.primary, title);
  // The failure glyph rides at the end of the title string (so tabs/OS titles
  // carry it too). `lastCommandFailed` tells us authoritatively that it's there,
  // so we can color it red and strip it from the editing/rename base without
  // guessing from the string (a user title ending in "✗" would fool a match).
  const failed = derived.lastCommandFailed === true;
  return {
    primary: failed ? displayTitle.slice(0, -` ${COMMAND_FAIL_GLYPH}`.length) : displayTitle,
    secondary: derived.secondary ?? null,
    failed,
  };
}
