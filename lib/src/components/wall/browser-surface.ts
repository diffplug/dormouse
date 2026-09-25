/**
 * Browser-surface param classification — the single source of truth for "what
 * renderer does this pane use?" and "is this a browser pane at all?". Used by the
 * BrowserPanel shell, the Wall (dispatch + lifecycle + CLI type), and the
 * dev-server-port correlation, so the classification never drifts between them.
 */
import {
  browserDisplayMode,
  type BrowserDisplayMode,
  type RenderMode,
} from './agent-browser-screen';
import type { BrowserBinding, SurfaceKind } from 'dor/commands/types';
import { isToolKeyScope, type ToolKeyScope } from '../../lib/platform/tool-types';
import { parseRenderMode, renderModeFor, sessionForKey } from 'dor-lib-common/browser-providers';
import { isBrowserViewportSetting, type BrowserViewportSetting } from 'dor-lib-common/browser-viewports';
import type { BrowserAutomationProvider } from '../../lib/platform/browser-automation';

/** A measured Playwright ratio belongs to its native context; only a ratio
 * explicitly requested for this Surface may be replayed on its next open. */
export function viewportFromMeasurement(
  provider: BrowserAutomationProvider,
  previous: BrowserViewportSetting | undefined,
  actual: { width: number; height: number; dpr: number },
): BrowserViewportSetting {
  const dpr = provider === 'agent-browser' ? actual.dpr
    : previous?.mode === 'fixed' && previous.dpr === actual.dpr ? previous.dpr : undefined;
  return { mode: 'fixed', width: actual.width, height: actual.height, ...(dpr === undefined ? {} : { dpr }) };
}

type BrowserParamsLike = {
  surfaceType?: unknown;
  renderMode?: unknown;
  session?: unknown;
  cwd?: unknown;
  binaryPath?: unknown;
  url?: unknown;
  /** Tool only: the ports found when autobind refused to choose. */
  toolPortConflict?: unknown;
  /** Tool only: `user` when the user-global config declared it. */
  toolScope?: unknown;
  /** Tool only: the approval this Surface is waiting on before it runs. */
  toolPending?: unknown;
  syncEngaged?: unknown;
  browserViewport?: unknown;
};

function asParams(params: unknown): BrowserParamsLike {
  return params && typeof params === 'object' ? (params as BrowserParamsLike) : {};
}

/** Resolve the canonical render mode; defaults to `iframe` when unset. */
export function resolveRenderMode(params: unknown): RenderMode {
  return parseRenderMode(asParams(params).renderMode).mode;
}

/** Whether params describe an automated browser, of either provider. */
export function isAgentBrowserParams(params: unknown): boolean {
  return parseRenderMode(asParams(params).renderMode).provider !== null;
}

/** Whether params describe a `tool` Surface — one Session with a terminal and,
 *  once it serves, a browser (`docs/specs/dor-tool.md`). Checked before the
 *  browser test below, because a serving tool also carries a `renderMode`. */
// The predicate names the discriminant so the negative branch keeps a plain
// params record rather than narrowing it away.
export function isToolParams(params: unknown): params is Record<string, unknown> & { surfaceType: 'tool' } {
  return asParams(params).surfaceType === 'tool';
}

/** The ports autobind found when it refused to choose among them, or null.
 *  Derived state, never persisted — see `persistableLeafMeta`. */
export function toolPortConflictFromParams(params: unknown): number[] | null {
  const value = asParams(params).toolPortConflict;
  return Array.isArray(value) && value.length > 0 && value.every((p) => typeof p === 'number')
    ? (value as number[])
    : null;
}

/** What a pending tool is waiting to be allowed to run. */
export interface ToolPending {
  readonly name: string;
  readonly run: string;
  /** Inputs as invoked; approval re-resolves them. */
  readonly args?: string[];
  /** Why the last approval attempt launched nothing; the prompt stays up. */
  readonly error?: string;
  /** The host confirmed the grant; subsequent attempts only repeat lookup. */
  readonly trustRecorded?: boolean;
  readonly path: string;
  readonly projectRoot: string;
  /** Requested at launch; applied after approval, since a pane the user cannot
   *  see is a pane they cannot approve. */
  readonly minimized: boolean;
  /** Preserve the launch request across the trust gate. */
  readonly fresh?: boolean;
  readonly upstreamUrl: string | null;
}

/** The approval a tool Surface is waiting on, or null once it may run. */
export function toolPendingFromParams(params: unknown): ToolPending | null {
  const value = asParams(params).toolPending;
  if (!value || typeof value !== 'object') return null;
  const pending = value as Record<string, unknown>;
  const strings = ['name', 'run', 'path', 'projectRoot'] as const;
  if (!strings.every((field) => typeof pending[field] === 'string')) return null;
  if (typeof pending.minimized !== 'boolean') return null;
  if (pending.fresh !== undefined && typeof pending.fresh !== 'boolean') return null;
  if (pending.upstreamUrl !== null && typeof pending.upstreamUrl !== 'string') return null;
  if (pending.args !== undefined && !(Array.isArray(pending.args) && pending.args.every((arg) => typeof arg === 'string'))) return null;
  if (pending.error !== undefined && typeof pending.error !== 'string') return null;
  if (pending.trustRecorded !== undefined && typeof pending.trustRecorded !== 'boolean') return null;
  return pending as unknown as ToolPending;
}

/**
 * Which of a tool's faces is forward. A three-state answer rather than a
 * boolean because the header and the body must agree: a port conflict occupies
 * the browser's place (there is nothing to frame, so the pane shows *why*
 * where the browser would have been) but has no URL to edit, so it must not
 * get browser chrome. Which halves are *mounted* never changes; see
 * `ToolPanel.tsx`.
 *
 * `browser` and `port-conflict` are mutually exclusive by construction —
 * autobind writes a conflict only when it declined to write a URL.
 */
export type ToolFace = 'terminal' | 'browser' | 'port-conflict' | 'pending-approval';

/** What occupies the tool's second half, or null when it has none yet.
 *  `toolFace` reads the conflict/browser mutual exclusion from this one place. */
function toolSecondFace(params: unknown): 'browser' | 'port-conflict' | null {
  if (!isToolParams(params)) return null;
  if (toolPortConflictFromParams(params) !== null) return 'port-conflict';
  return browserUrlFromParams(params) !== null ? 'browser' : null;
}

export function toolFace(params: unknown): ToolFace {
  if (!isToolParams(params)) return 'terminal';
  // Checked before everything: until the human
  // approves, there is no terminal to show — nothing has spawned.
  if (toolPendingFromParams(params) !== null) return 'pending-approval';
  return toolSecondFace(params) ?? 'terminal';
}

/** Whether a tool Surface's params carry `key`. A null or absent key never
 *  matches — not even another null: a tool has an identity if and only if it
 *  was given one, so two identityless tools are two tools
 *  (`docs/specs/dor-tool.md` -> Identity and dedupe). */
export function toolKeysEqual(paramsKey: unknown, key: readonly string[] | null): boolean {
  if (key === null || !Array.isArray(paramsKey)) return false;
  return paramsKey.length === key.length && paramsKey.every((element, index) => element === key[index]);
}

/**
 * Namespace a declared key under the tool identity the *host* resolved from the
 * spawn (`docs/specs/dor-tool.md` -> Identity and dedupe).
 *
 * Two things depend on this, and both break without it. Scope-only keys are
 * legal — the spec calls the declared list "scope inside that namespace" — so
 * `docs` and `api` both declaring `[$PROJECT_ROOT]` must stay distinct. And a
 * key that arrives at runtime over OSC 367 comes from process output: without a
 * namespace it could name another tool's key, and the next `dor tool <that
 * tool>` would adopt — and Ctrl+C and re-run — the announcing pane instead.
 *
 * `null` for an identityless tool, which never matches anything, so an OSC
 * re-key cannot mint an identity for a `dor tool -- <command>`.
 */
export function namespacedToolKey(
  toolName: string | null,
  key: readonly string[] | null,
): string[] | null {
  if (!toolName || key === null) return null;
  return [toolName, ...key];
}

/** Tool reuse scope: `user` for user-global config, undefined for project
 *  `dormouse.yml`, and `builtin` for the built-in viewer. Dedupe compares the
 *  scope alongside the key (`docs/specs/dor-tool.md` -> Declaring tools). */
export function toolScopeFromParams(params: unknown): ToolKeyScope | undefined {
  const scope = asParams(params).toolScope;
  return isToolKeyScope(scope) ? scope : undefined;
}

/** Whether params describe a plain browser surface (vs a terminal): the unified
 *  'browser' type, or anything carrying a renderMode. A tool is neither — it is
 *  its own kind, and `isToolParams` answers for it. */
export function isBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  if (isToolParams(params)) return false;
  return p.surfaceType === 'browser' || typeof p.renderMode === 'string';
}

/** Browser display identity projected from canonical persisted params. */
export function browserDisplayModeFromParams(params: unknown): BrowserDisplayMode | undefined {
  if (!isBrowserParams(params)) return undefined;
  const p = asParams(params);
  return browserDisplayMode({
    renderMode: resolveRenderMode(p),
    syncEngaged: p.syncEngaged === true || (isBrowserViewportSetting(p.browserViewport) && p.browserViewport.mode === 'pane-sync'),
  });
}

/** The Surface kind these params describe — the params → kind step beneath
 *  `hasTerminal` / `hasBrowser` (`dor/commands/types`). Keep every params-level
 *  kind switch on this one function so a future kind changes the classification
 *  in one place. The boolean-derived return type-checks against a widened
 *  `SurfaceKind`, so nothing here forces the edit; what catches a forgotten
 *  kind is `use-session-persistence.ts`, where this return flows into the
 *  narrower `PersistedSurfaceType`. */
export function surfaceKindFromParams(params: unknown): SurfaceKind {
  if (isToolParams(params)) return 'tool';
  return isBrowserParams(params) ? 'browser' : 'terminal';
}

/** The automation session a browser surface is bound to — the join key
 *  of the session↔surface registry — or null when the surface is not
 *  automated, or its launch has not yet named one (`docs/specs/dor-browser.md`
 *  → "Browser Connection"). */
export function agentBrowserSessionFromParams(params: unknown): string | null {
  if (!isAgentBrowserParams(params)) return null;
  const session = asParams(params).session;
  return typeof session === 'string' && session ? session : null;
}

/** The native binding an automated browser surface's params carry — what its
 *  provider's CLI runs with — or null before the session is named. */
export function browserBindingFromParams(params: unknown): BrowserBinding | null {
  const session = agentBrowserSessionFromParams(params);
  if (!session) return null;
  const { cwd, binaryPath } = asParams(params);
  return {
    session,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof binaryPath === 'string' ? { binaryPath } : {}),
  };
}

/**
 * What the Wall does when a Surface's first launch fails
 * (docs/specs/dor-browser.md → "Browser Connection"), stored by whoever
 * created it so a pane restored mid-launch still gets it: close the pane, fall
 * a Tool back to its embed, or restore the renderer a swap replaced.
 */
export type LaunchFallback = 'close' | 'embed' | { restore: Record<string, unknown> };

export function launchFallbackFromParams(params: unknown): LaunchFallback | null {
  const fallback = (params as { launchFallback?: unknown } | null | undefined)?.launchFallback;
  if (fallback === 'close' || fallback === 'embed') return fallback;
  const restore = (fallback as { restore?: unknown } | null | undefined)?.restore;
  return restore && typeof restore === 'object' ? { restore: restore as Record<string, unknown> } : null;
}

/** The params that launch a Tool's agent-drivable browser at `url`, in the
 *  session it had or else its own (`tool.<leafId>`), falling back to the embed
 *  when it cannot come up (docs/specs/dor-tool.md → Serving). */
export function toolBrowserLaunchParams(leafId: string, params: Record<string, unknown>, url: string, provider: 'agent-browser' | 'playwright' = 'agent-browser'): Record<string, unknown> {
  return {
    url,
    renderMode: renderModeFor(provider, 'screencast'),
    ...(isBrowserViewportSetting(params.browserViewport) ? { browserViewport: params.browserViewport as BrowserViewportSetting } : {}),
    session: undefined,
    launchSession: typeof params.session === 'string' ? params.session : sessionForKey(`tool.${leafId}`),
    launchFallback: 'embed' satisfies LaunchFallback,
  };
}

/** The target URL a browser surface carries in its params (`dor list`); null
 *  when absent (e.g. a terminal, or a browser surface with no URL yet). */
export function browserUrlFromParams(params: unknown): string | null {
  const url = asParams(params).url;
  return typeof url === 'string' ? url : null;
}
