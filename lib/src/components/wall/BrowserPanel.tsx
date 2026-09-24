/**
 * The single body component for every browser surface (docs/specs/dor-browser.md
 * → "Display Modal And Render Swaps").
 *
 * One surface, swappable renderer: it reads the canonical `renderMode` and mounts
 * the matching child — `IframePanel` for `iframe`, `AgentBrowserPanel` for
 * `ab-screencast` / `ab-popout`. The two children stay separate components (their
 * input models differ — CDP `input_*` messages vs native DOM); the shell only owns
 * the renderer choice. The browser chrome each child registers is keyed by
 * `api.id`, so the shared header/modal are unaffected by which child is mounted.
 */
import type { RenderMode } from './agent-browser-screen';
import { resolveRenderMode } from './browser-surface';
import type { PaneProps } from './pane-props';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { IframePanel } from './IframePanel';
import { NotepadPanel } from '../NotepadPanel';

/** Canonical persisted state for a browser surface. `renderMode` + `url` are the
 *  single source of truth across swaps; the agent-browser fields ride flat and are
 *  present only for automation modes. */
export type BrowserPanelParams = {
  surfaceType?: string;
  renderMode?: RenderMode;
  url?: string;
  cwd?: string;
  nativeIdentity?: string;
  /** Bound once the browser is up; absent while the Surface's controller
   *  launches it (docs/specs/dor-browser.md → "Browser Connection"). */
  session?: string;
  /** With no `session`, the one the launch opens `url` in: a Tool's own, or
   *  the previous provider's when a failed swap restores it. */
  launchSession?: string;
  key?: string;
  binaryPath?: string;
  syncEngaged?: boolean;
  /** Set only on a Surface the pane context menu opened for a port, as
   *  `<sourceSurfaceId>:<port>:<iframe|agent|playwright>`, `agent` being
   *  agent-browser's. Reuse looks a Surface up by it,
   *  so a second "open this port" reveals the pane the first one made rather
   *  than stacking another (`docs/specs/dor-browser.md` → Pane Context Menu
   *  Connect). */
  contextPortKey?: string;
};

export function BrowserPanel(props: PaneProps & { renderNotepad?: boolean }) {
  const renderMode = resolveRenderMode(props.params);
  // The wrapper is the notepad panel's containing block, and the one thing both
  // renderers share; each child still fills it and owns its own chrome.
  return (
    <div className="relative h-full w-full">
      {renderMode === 'iframe'
        ? <IframePanel {...props} />
        : <AgentBrowserPanel {...props} renderMode={renderMode} />}
      {props.renderNotepad !== false && <NotepadPanel surfaceId={props.id} />}
    </div>
  );
}
