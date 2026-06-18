/**
 * The single dockview component for every browser surface (docs/specs/dor-iframe.md
 * → "Path 1 — One `browser` surface, swappable renderer").
 *
 * One surface, swappable renderer: it reads the canonical `renderMode` and mounts
 * the matching child — `IframePanel` for `iframe`, `AgentBrowserPanel` for
 * `ab-screencast` / `ab-popout`. The two children stay separate components (their
 * input models differ — CDP `input_*` messages vs native DOM); the shell only owns
 * the renderer choice. The browser chrome each child registers is keyed by
 * `api.id`, so the shared header/modal are unaffected by which child is mounted.
 */
import { useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { RenderMode } from './agent-browser-screen';
import { resolveRenderMode } from './browser-surface';
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
  /** Legacy: surfaces persisted before `renderMode` existed stored pop-out as a
   *  boolean alongside surfaceType 'iframe' | 'agent-browser'. Migrated below. */
  poppedOut?: boolean;
};

export function BrowserPanel(props: IDockviewPanelProps<BrowserPanelParams>) {
  const { api, params } = props;
  const renderMode = resolveRenderMode(params);

  // Canonicalize a legacy layout once: write renderMode + surfaceType:'browser'
  // so later reads and persistence use the unified shape (the children read
  // renderMode from the prop below, so this is purely for the persisted blob).
  useEffect(() => {
    if (params?.renderMode === renderMode && params?.surfaceType === 'browser') return;
    api.updateParameters({ renderMode, surfaceType: 'browser' });
  }, [api, params?.renderMode, params?.surfaceType, renderMode]);

  if (renderMode === 'iframe') return <IframePanel {...props} />;
  return <AgentBrowserPanel {...props} renderMode={renderMode} />;
}
