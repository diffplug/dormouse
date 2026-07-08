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

/** Canonical persisted state for a browser surface. `renderMode` + `url` are the
 *  single source of truth across swaps; the agent-browser fields ride flat and are
 *  present only for `ab-*` modes. */
export type BrowserPanelParams = {
  surfaceType?: string;
  renderMode?: RenderMode;
  url?: string;
  session?: string;
  key?: string;
  wsPort?: number;
  binaryPath?: string;
  syncEngaged?: boolean;
};

export function BrowserPanel(props: PaneProps) {
  const renderMode = resolveRenderMode(props.params);
  if (renderMode === 'iframe') return <IframePanel {...props} />;
  return <AgentBrowserPanel {...props} renderMode={renderMode} />;
}
