/**
 * Browser-surface param classification — the single source of truth for "what
 * renderer does this pane use?" and "is this a browser pane at all?". Used by the
 * BrowserPanel shell, the Wall (dispatch + lifecycle + CLI type), and the
 * dev-server-port correlation, so the classification never drifts between them.
 */
import type { RenderMode } from './agent-browser-screen';

type BrowserParamsLike = {
  surfaceType?: unknown;
  renderMode?: unknown;
  url?: unknown;
};

function asParams(params: unknown): BrowserParamsLike {
  return params && typeof params === 'object' ? (params as BrowserParamsLike) : {};
}

/** Resolve the canonical render mode; defaults to `iframe` when unset. */
export function resolveRenderMode(params: unknown): RenderMode {
  const p = asParams(params);
  return p.renderMode === 'ab-screencast' || p.renderMode === 'ab-popout' ? p.renderMode : 'iframe';
}

/** Whether params describe an agent-browser-rendered surface (ab-screencast /
 *  ab-popout). */
export function isAgentBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  return p.renderMode === 'ab-screencast' || p.renderMode === 'ab-popout';
}

/** Whether params describe any browser surface (vs a terminal): the unified
 *  'browser' type, or anything carrying a renderMode. */
export function isBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  return p.surfaceType === 'browser' || typeof p.renderMode === 'string';
}

/** The target URL a browser surface carries in its params (`dor list`); null
 *  when absent (e.g. a terminal, or a browser surface with no URL yet). */
export function browserUrlFromParams(params: unknown): string | null {
  const url = asParams(params).url;
  return typeof url === 'string' ? url : null;
}
