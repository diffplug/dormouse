/**
 * Browser-surface param classification — the single source of truth for "what
 * renderer does this pane use?" and "is this a browser pane at all?", including
 * migration of layouts persisted before `renderMode` existed (surfaceType
 * 'iframe' | 'agent-browser' + a `poppedOut` boolean). Used by the BrowserPanel
 * shell, the Wall (dispatch + lifecycle + CLI type), and the dev-server-port
 * correlation, so the classification never drifts between them.
 */
import type { RenderMode } from './agent-browser-screen';

type BrowserParamsLike = {
  surfaceType?: unknown;
  renderMode?: unknown;
  session?: unknown;
  poppedOut?: unknown;
};

function asParams(params: unknown): BrowserParamsLike {
  return params && typeof params === 'object' ? (params as BrowserParamsLike) : {};
}

/** Resolve the canonical render mode, migrating a legacy layout blob. */
export function resolveRenderMode(params: unknown): RenderMode {
  const p = asParams(params);
  if (p.renderMode === 'ab-screencast' || p.renderMode === 'ab-popout' || p.renderMode === 'iframe') {
    return p.renderMode;
  }
  if (p.surfaceType === 'iframe') return 'iframe';
  if (p.surfaceType === 'agent-browser' || typeof p.session === 'string') {
    return p.poppedOut ? 'ab-popout' : 'ab-screencast';
  }
  return 'iframe';
}

/** Whether params describe an agent-browser-rendered surface (ab-screencast /
 *  ab-popout, or a legacy agent-browser blob). */
export function isAgentBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  return p.renderMode === 'ab-screencast' || p.renderMode === 'ab-popout' || p.surfaceType === 'agent-browser';
}

/** Whether params describe any browser surface (vs a terminal): the unified
 *  'browser' type, a legacy iframe/agent-browser blob, or anything carrying a
 *  renderMode. */
export function isBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  return p.surfaceType === 'browser' || p.surfaceType === 'iframe'
    || p.surfaceType === 'agent-browser' || typeof p.renderMode === 'string';
}
