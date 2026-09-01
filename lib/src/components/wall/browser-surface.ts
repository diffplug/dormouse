/**
 * Browser-surface param classification — the single source of truth for "what
 * renderer does this pane use?" and "is this a browser pane at all?". Used by the
 * BrowserPanel shell, the Wall (dispatch + lifecycle + CLI type), and the
 * dev-server-port correlation, so the classification never drifts between them.
 */
import type { RenderMode } from './agent-browser-screen';
import type { SurfaceKind } from 'dor/commands/types';

type BrowserParamsLike = {
  surfaceType?: unknown;
  renderMode?: unknown;
  session?: unknown;
  url?: unknown;
  /** Tool only: the header chip pinning the terminal forward past serving. */
  showTerminal?: unknown;
  /** Tool only: the ports found when autobind refused to choose. */
  toolPortConflict?: unknown;
  /** Tool only: the approval this Surface is waiting on before it runs. */
  toolPending?: unknown;
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

/** Whether params describe a `tool` Surface — one Session with a terminal and,
 *  once it serves, a browser (`docs/specs/dor-tool.md`). Checked before the
 *  browser test below, because a serving tool also carries a `renderMode`. */
export function isToolParams(params: unknown): boolean {
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
  readonly path: string;
  readonly projectRoot: string;
  /** Requested at launch; applied after approval, since a pane the user cannot
   *  see is a pane they cannot approve. */
  readonly minimized: boolean;
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
  if (pending.upstreamUrl !== null && typeof pending.upstreamUrl !== 'string') return null;
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

/** What occupies the tool's second half, ignoring the terminal pin, or null
 *  when it has none yet — the header chip's gate as well as `toolFace`'s
 *  browser branch, so both read the mutual exclusion from one place. */
export function toolSecondFace(params: unknown): 'browser' | 'port-conflict' | null {
  if (!isToolParams(params)) return null;
  if (toolPortConflictFromParams(params) !== null) return 'port-conflict';
  return browserUrlFromParams(params) !== null ? 'browser' : null;
}

export function toolFace(params: unknown): ToolFace {
  if (!isToolParams(params)) return 'terminal';
  // Checked before everything, including the terminal pin: until the human
  // approves, there is no terminal to show — nothing has spawned.
  if (toolPendingFromParams(params) !== null) return 'pending-approval';
  if (asParams(params).showTerminal === true) return 'terminal';
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

/** Whether params describe a plain browser surface (vs a terminal): the unified
 *  'browser' type, or anything carrying a renderMode. A tool is neither — it is
 *  its own kind, and `isToolParams` answers for it. */
export function isBrowserParams(params: unknown): boolean {
  const p = asParams(params);
  if (isToolParams(params)) return false;
  return p.surfaceType === 'browser' || typeof p.renderMode === 'string';
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

/** The agent-browser session an ab-rendered surface is bound to — the join key
 *  of the session↔surface registry — or null when the surface is not
 *  ab-rendered, or is one the context-menu connect created eagerly and the
 *  daemon has not yet named (`docs/specs/dor-browser.md` → Pane Context Menu
 *  Connect). */
export function agentBrowserSessionFromParams(params: unknown): string | null {
  if (!isAgentBrowserParams(params)) return null;
  const session = asParams(params).session;
  return typeof session === 'string' && session ? session : null;
}

/** The target URL a browser surface carries in its params (`dor list`); null
 *  when absent (e.g. a terminal, or a browser surface with no URL yet). */
export function browserUrlFromParams(params: unknown): string | null {
  const url = asParams(params).url;
  return typeof url === 'string' ? url : null;
}
