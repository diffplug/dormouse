import { useCallback, useEffect, type MutableRefObject } from 'react';
import { getPlatform, PLATFORM_STRING } from '../../lib/platform';
import type { DorControlRequestPayload, DorControlResult } from 'dor/protocol';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import type {
  Surface as DorSurface,
  SplitDirection as DorSplitDirection,
  ResolvedSplitDirection as DorResolvedSplitDirection,
  ParseResult,
  SurfacePort as DorSurfacePort,
} from 'dor/commands/types';
import type { OpenPort } from '../../lib/platform/types';
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';
import {
  getDefaultShellOpts,
  getTerminalInstance,
  getTerminalPaneState,
  isPaneOscDriven,
} from '../../lib/terminal-registry';
import { surfaceRunsCommand, type TerminalPaneState } from '../../lib/terminal-state';
import { hostPathDisplay } from './browser-url';
import { isAgentBrowserParams } from './browser-surface';
// One-way import: connect-port no longer depends on this module (its eager-surface
// and refresh seams are injected as plain functions).
import { connectPortToDefaultBrowser } from './connect-port';
import { listenerUrlsByPort } from './port-url';
import { dorDirectionForEdge, type LathWallEngine } from './lath-wall-engine';
import type { WallNav } from './keyboard/types';
import type { DooredItem } from './wall-types';

type DorControlParams = {
  command?: unknown;
  confirmation?: unknown;
  cwd?: unknown;
  direction?: unknown;
  focusNeutral?: unknown;
  input?: unknown;
  inputCount?: unknown;
  key?: unknown;
  lines?: unknown;
  minimized?: unknown;
  restart?: unknown;
  binaryPath?: unknown;
  includePorts?: unknown;
  pane?: string;
  session?: unknown;
  surface?: unknown;
  url?: unknown;
  workspace?: string;
  window?: string;
  scrollback?: unknown;
  wsPort?: unknown;
};

// The webview view of a control request: the shared wire payload, but with
// semantically-typed params and a `respond` callback the transport layer wires
// back to the request's `requestId`.
type DorControlRequest = Omit<DorControlRequestPayload, 'params'> & {
  params?: DorControlParams;
  respond: (response: DorControlResult) => void;
};

/** Outcome of {@link EnsureAgentBrowserSurface}: the fields the caller maps onto
 *  its response, or a failure message. `minimized` is the surface's current
 *  minimized state (the reused surface's, or the requested value for a fresh one). */
type EnsureAgentBrowserSurfaceResult =
  | { ok: true; status: 'created' | 'existing' | 'replaced'; surfaceId: string; surfaceRef: string; minimized: boolean }
  | { ok: false; message: string };

/** Reuse-or-create an agent-browser browser surface — the surface half of
 *  `dor ab` (the control plane), and, with `session` omitted, the pane context
 *  menu's eager session-less create (docs/specs/dor-browser.md → Pane Context
 *  Menu Connect). At least one of `key` / `session` is required (it names the
 *  surface). */
type EnsureAgentBrowserSurface = (args: {
  key?: string;
  /** Omitted for the eager connect pane, which is created session-less on
   *  purpose so the controller stays inert until the daemon is up; the reuse
   *  arm is skipped (there is no session to match). */
  session?: string;
  url?: string;
  wsPort?: number;
  binaryPath?: string;
  /** Resolved lazily, only when a fresh surface must be created: the reuse path
   *  must succeed without a visible reference (e.g. `dor ab` from a minimized
   *  terminal refreshing an existing surface). */
  reference: () => ParseResult<DorSurface>;
  minimized?: boolean;
}) => EnsureAgentBrowserSurfaceResult;

function isSingletonWorkspaceTarget(target: string | undefined): boolean {
  return !target || target === 'workspace:1' || target === '1';
}

function isSingletonWindowTarget(target: string | undefined): boolean {
  return !target || target === 'window:1' || target === '1';
}

function matchesDorSurfaceTarget(
  target: string | undefined,
  surface: DorSurface,
  callerSurfaceId: string | undefined,
): boolean {
  if (!target) return true;
  if (target === 'surface:focused') return surface.focused;
  if (target === 'surface:self') return callerSurfaceId !== undefined && surface.id === callerSurfaceId;
  if (target === surface.id || target === surface.ref) return true;
  if (!target.startsWith('surface:')) return false;
  const stableId = target.slice('surface:'.length);
  return stableId.length > 0 && stableId === surface.id;
}

function surfaceTitleTarget(target: string): string | null {
  return target.startsWith('title:') ? target.slice('title:'.length) : null;
}

function renderSurfaceForError(surface: DorSurface): string {
  return `${surface.ref} ${JSON.stringify(surface.title)}`;
}

// Resolve exactly one match: ok for a single hit, an ambiguity error for many,
// null for none (each caller supplies its own not-found / fallback tail).
function pickSingleMatch(matches: DorSurface[], resolvedTarget: string): ParseResult<DorSurface> | null {
  if (matches.length === 1) return { ok: true, value: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      message: `surface target '${resolvedTarget}' matched multiple surfaces: ${matches.map(renderSurfaceForError).join(', ')}`,
    };
  }
  return null;
}

function resolveSurfaceTarget(
  surfaces: DorSurface[],
  target: string | undefined,
  callerSurfaceId: string | undefined,
): ParseResult<DorSurface> {
  const resolvedTarget = target ?? callerSurfaceId ?? 'surface:focused';
  const titleTarget = surfaceTitleTarget(resolvedTarget);
  if (titleTarget !== null) {
    const matches = surfaces.filter((surface) => surface.title === titleTarget);
    return pickSingleMatch(matches, resolvedTarget)
      ?? { ok: false, message: `surface target '${resolvedTarget}' was not found` };
  }

  const matches = surfaces.filter((surface) => matchesDorSurfaceTarget(resolvedTarget, surface, callerSurfaceId));
  const single = pickSingleMatch(matches, resolvedTarget);
  if (single) return single;
  const fallback = !target && !callerSurfaceId ? (surfaces[0] ?? null) : null;
  if (fallback) return { ok: true, value: fallback };
  return { ok: false, message: `surface '${resolvedTarget}' was not found` };
}

function toSurfacePort(port: OpenPort): DorSurfacePort {
  return {
    family: port.family,
    address: port.address,
    port: port.port,
    pid: port.pid,
    ...(port.processName ? { processName: port.processName } : {}),
  };
}

/** Enumerate each terminal Surface's listening ports for `dor list --ports`.
 *  The adapter shells out per pane (and returns `[]` on remote / on error), so
 *  the fetches run in parallel and failures degrade to no ports, never a reject. */
async function attachSurfacePorts(surfaces: DorSurface[]): Promise<DorSurface[]> {
  const platform = getPlatform();
  return Promise.all(surfaces.map(async (surface) => {
    if (surface.kind !== 'terminal') return surface;
    try {
      const ports = await platform.getOpenPorts(surface.id);
      return { ...surface, ports: ports.map(toSurfacePort) };
    } catch {
      return { ...surface, ports: [] };
    }
  }));
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanParam(value: unknown): boolean {
  return value === true;
}

function stringArrayParam(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitLines(text: string, lines: number | undefined): string {
  if (lines === undefined) return text;
  const parts = text.split('\n');
  return parts.slice(-lines).join('\n');
}

function readSurfaceText(surfaceId: string, lines: number | undefined, scrollback: boolean): string {
  const terminal = getTerminalInstance(surfaceId);
  if (!terminal) return '';

  // Read rendered text straight off the xterm buffer so both modes return clean,
  // ANSI-free lines and `--lines` trims by rendered line consistently. With
  // scrollback we walk the whole buffer (history + screen); otherwise just the
  // visible screen, which sits at `baseY..length`.
  const buffer = terminal.buffer.active;
  const start = scrollback ? 0 : Math.max(0, buffer.baseY);
  const end = buffer.length;
  const collected: string[] = [];
  for (let row = start; row < end; row += 1) {
    collected.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  return limitLines(collected.join('\n').replace(/\n+$/, ''), lines);
}

// `dor ensure --restart` blocks the CLI while we interrupt a live command and
// re-run it. Rather than guess at timings, poll the integration-derived
// terminal state: a command is gone once `currentCommand` clears (commandFinish
// → prompt) and back once the surface reports the same command live again.
const RESTART_POLL_INTERVAL_MS = 100;
const RESTART_INTERRUPT_TIMEOUT_MS = 15_000;
const RESTART_START_TIMEOUT_MS = 15_000;

/** Resolve true once `predicate` holds for the surface's live state, false on timeout. */
function waitForTerminalState(
  id: string,
  predicate: (state: TerminalPaneState) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate(getTerminalPaneState(id))) return Promise.resolve(true);
  return new Promise((resolve) => {
    let elapsed = 0;
    const timer = setInterval(() => {
      if (predicate(getTerminalPaneState(id))) {
        clearInterval(timer);
        resolve(true);
      } else if ((elapsed += RESTART_POLL_INTERVAL_MS) >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, RESTART_POLL_INTERVAL_MS);
  });
}

/**
 * Restart a surface already running `command` in `cwd`: interrupt it (Ctrl+C),
 * wait for the shell to return to its prompt, type the command again, and wait
 * for it to go live. Drives the live PTY directly, so it works for minimized
 * doors too (their PTY keeps running). Returns a message on failure.
 */
async function restartSurfaceInPlace(id: string, command: string, cwd: string): Promise<ParseResult<undefined>> {
  // A match is by construction OSC-driven (surfaceRunsCommand only matches a
  // shell that reports its command), so this never fires on the real path — but
  // it guarantees we never fire Ctrl+C into a non-integration shell (e.g. cmd.exe
  // popping `Terminate batch job (Y/N)?`).
  if (!isPaneOscDriven(id)) return { ok: false, message: 'has no Dormouse shell integration to restart' };
  const platform = getPlatform();
  platform.writePty(id, '\x03');
  const interrupted = await waitForTerminalState(
    id,
    (state) => state.currentCommand === null,
    RESTART_INTERRUPT_TIMEOUT_MS,
  );
  if (!interrupted) return { ok: false, message: 'did not return to a prompt after interrupt' };
  platform.writePty(id, `${command}\r`);
  const restarted = await waitForTerminalState(
    id,
    (state) => surfaceRunsCommand(state, command, cwd),
    RESTART_START_TIMEOUT_MS,
  );
  if (!restarted) return { ok: false, message: 'command did not restart' };
  return { ok: true, value: undefined };
}

// A `dor ensure -- <command>` command is typed into the shell programmatically,
// which bypasses the keystroke heuristic — so only a shell whose integration
// emits OSC 633 boundaries ever reports the command back, which is what makes the
// surface matchable/restartable. `dor ensure` requires it. We give the shell this
// long to draw its first integrated prompt (headroom for a cold-start shell
// loading a profile / under AV) before concluding it has no integration.
const INTEGRATION_DETECT_TIMEOUT_MS = 8_000;

// Shown to the user (via the CLI's stderr) when `dor ensure` can't run because the
// target shell has no OSC 633 integration. `shell` is a display name when known.
function missingIntegrationError(shell?: string): string {
  const name = (shell ?? '').replace(/\\/g, '/').split('/').pop() || 'this shell';
  return `dor ensure requires OSC 633 shell integration, which ${name} does not provide. Run it from a shell with Dormouse integration, such as Git Bash or PowerShell.`;
}

function killConfirmationParam(value: unknown): { mode: 'if-read'; text: string } | { mode: 'dangerously' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const confirmation = value as { mode?: unknown; text?: unknown };
  if (confirmation.mode === 'dangerously') return { mode: 'dangerously' };
  if (confirmation.mode === 'if-read' && typeof confirmation.text === 'string') {
    return { mode: 'if-read', text: confirmation.text };
  }
  return null;
}

function parseDorSplitDirection(value: unknown): DorSplitDirection | null {
  if (value === undefined || value === null) return 'auto';
  if (value === 'left' || value === 'right' || value === 'up' || value === 'down' || value === 'auto') return value;
  return null;
}

/**
 * Quote a raw argv into a single command string for the target pane's shell.
 * This is the one place the command is quoted; the CLI sends argv unquoted
 * precisely because only the webview knows which shell will run it.
 */
function dorCommandString(args: string[] | undefined): string | undefined {
  if (!args || args.join('').trim() === '') return undefined;
  const shell = getDefaultShellOpts()?.shell;
  return buildShellCommandForKind(shellCommandKind(shell, PLATFORM_STRING), args);
}

/**
 * The `dor` control plane: the webview handler for `dormouse:control-request`
 * events (the `surface.*` methods that back the `dor` CLI) plus its private
   * surface-resolution/query helpers. This is CLI policy — surface targeting,
 * param coercion, command quoting, restart/integration timing — not wall layout;
 * the layout primitives it drives (`createSplitSurface`, `createContentSurface`,
 * `killPaneImmediately`, `buildDorSurfaces`, `surfaceRefForId`) are owned by the
 * Wall and injected here (docs/specs/dor-cli.md).
 */
export function useDorControl({
  lath,
  nav,
  doorsRef,
  setDoors,
  buildDorSurfaces,
  buildDorSurfaceList,
  surfaceRefForId,
  createSplitSurface,
  createContentSurface,
  killPaneImmediately,
  revealSurface,
  lastAgentBrowserBinaryPathRef,
}: {
  /** The Lath engine — visible-pane projection (`lath.listPanes()`), aspect-ratio
   *  split resolution (`autoEdgeFor`), and per-leaf param writes. */
  lath: LathWallEngine;
  /** The navigation/query seam; the handler only needs `hasPane`. */
  nav: WallNav;
  doorsRef: MutableRefObject<DooredItem[]>;
  setDoors: (doors: DooredItem[]) => void;
  /** The visible panes + active surface projection, shared with wallActions. */
  buildDorSurfaces: () => DorSurface[];
  /** Like `buildDorSurfaces` but also includes minimized (doored) Surfaces —
   *  the full `dor list` view. */
  buildDorSurfaceList: () => DorSurface[];
  /** Stable `surface:N` ref for a pane/door id, shared with the render. */
  surfaceRefForId: (id: string) => string;
  createSplitSurface: (args: {
    command?: string;
    direction: DorResolvedSplitDirection;
    minimized: boolean;
    reference: DorSurface;
    cwd?: string;
    requireIntegration?: boolean;
    focusNeutral?: boolean;
  }) => ParseResult<{ id: string; ref: string; minimized: boolean }>;
  createContentSurface: (args: {
    minimized: boolean;
    params: Record<string, unknown>;
    reference: DorSurface;
    title: string;
    focusNeutral?: boolean;
  }) => ParseResult<{ id: string; ref: string; status: 'created' | 'replaced' }>;
  killPaneImmediately: (id: string) => void;
  /** Put the selection on a surface, reattaching it first when it is minimized.
   *  Used by the human-initiated `connectPort` (a menu click is a request to see
   *  that surface); the `dor ab` control path stays focus-neutral. */
  revealSurface: (id: string) => void;
  /** The last binary path a `dor ab` surface resolved on a terminal's PATH. */
  lastAgentBrowserBinaryPathRef: MutableRefObject<string | undefined>;
}): { connectPort: (id: string, url: string) => Promise<void> } {
  const resolveVisibleSurface = useCallback((
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => resolveSurfaceTarget(buildDorSurfaces(), target, callerSurfaceId), [buildDorSurfaces]);

  const resolveListedSurface = useCallback((
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => resolveSurfaceTarget(buildDorSurfaceList(), target, callerSurfaceId), [buildDorSurfaceList]);

  // The shared prelude of the direct-operation handlers (send / read / kill): a
  // target surface is required and must resolve against the listed surfaces.
  // Responds with the failure and returns null so the caller just bails.
  const requireListedSurface = useCallback((
    surfaceParam: unknown,
    detail: DorControlRequest,
  ): DorSurface | null => {
    const surface = stringParam(surfaceParam);
    if (!surface) {
      detail.respond({ ok: false, error: 'surface is required' });
      return null;
    }
    const target = resolveListedSurface(surface, detail.surfaceId);
    if (!target.ok) {
      detail.respond({ ok: false, error: target.message });
      return null;
    }
    return target.value;
  }, [resolveListedSurface]);

  // requireListedSurface plus the terminal-only guard shared by the handlers that
  // read/write/scan a shell (send / read / resolveOpen). Responds and returns null
  // on a browser-surface target so the caller just bails.
  const requireTerminalSurface = useCallback((
    surfaceParam: unknown,
    detail: DorControlRequest,
  ): DorSurface | null => {
    const target = requireListedSurface(surfaceParam, detail);
    if (!target) return null;
    if (target.kind !== 'terminal') {
      detail.respond({ ok: false, error: `surface '${target.ref}' is not a terminal` });
      return null;
    }
    return target;
  }, [requireListedSurface]);

  const findSurfaceIdRunningCommand = useCallback((command: string, cwdPath: string): string | null => {
    const ids = [
      ...lath.listPanes().map((panel) => panel.id),
      ...doorsRef.current.map((door) => door.id),
    ];
    return ids.find((id) => surfaceRunsCommand(getTerminalPaneState(id), command, cwdPath)) ?? null;
  }, [lath]);

  /**
   * The surface (visible pane or minimized door — panes win) whose params match,
   * derived from panel/door params rather than kept as separate state so it
   * survives webview reloads. Null when nothing matches.
   */
  const findSurfaceByParams = useCallback((isMatch: (params: unknown) => boolean): { id: string; minimized: boolean } | null => {
    const panel = lath.listPanes().find((candidate) => isMatch(candidate.params));
    if (panel) return { id: panel.id, minimized: false };
    const door = doorsRef.current.find((candidate) => isMatch(candidate.params));
    if (door) return { id: door.id, minimized: true };
    return null;
  }, [lath]);

  /** The agent-browser session ↔ surface registry: the surface bound to
   *  `session`, or null if none exists. */
  const findAgentBrowserSurface = useCallback((session: string) => findSurfaceByParams((params) =>
    isAgentBrowserParams(params) && (params as { session?: unknown }).session === session,
  ), [findSurfaceByParams]);

  // Fold a params patch onto a surface whether it's a visible pane (engine
  // metadata) or a minimized door (the doorsRef map) — the reuse/refresh
  // mechanics shared by `ensureAgentBrowserSurface`'s reuse arm and the
  // connect-port refresh seam. A no-op on an empty patch.
  const updateSurfaceParams = useCallback((id: string, patch: Record<string, unknown>) => {
    if (Object.keys(patch).length === 0) return;
    const door = doorsRef.current.find((candidate) => candidate.id === id);
    if (door) {
      const nextDoors = doorsRef.current.map((d) => d.id === id
        ? { ...d, params: { ...d.params, ...patch } }
        : d);
      doorsRef.current = nextDoors;
      setDoors(nextDoors);
    } else {
      lath.store.updateParams(id, patch);
    }
  }, [doorsRef, lath, setDoors]);

  const ensureAgentBrowserSurface = useCallback<EnsureAgentBrowserSurface>(({
    key,
    session,
    url,
    wsPort,
    binaryPath,
    reference,
    minimized = false,
  }) => {
    // Remember the resolved binary so an embed→screencast swap can spawn one.
    if (binaryPath) lastAgentBrowserBinaryPathRef.current = binaryPath;
    const refreshedParams = {
      ...(wsPort !== undefined ? { wsPort } : {}),
      ...(binaryPath !== undefined ? { binaryPath } : {}),
    };

    const existing = session === undefined ? null : findAgentBrowserSurface(session);
    if (existing) {
      // Reuse: refresh the stream port (OS-assigned, churns across session
      // restarts) so the panel reconnects to the live stream, and the
      // resolved binary path alongside it.
      updateSurfaceParams(existing.id, refreshedParams);
      return {
        ok: true,
        status: 'existing',
        surfaceId: existing.id,
        surfaceRef: surfaceRefForId(existing.id),
        minimized: existing.minimized,
      };
    }

    const title = key ?? session;
    if (title === undefined) return { ok: false, message: 'an agent-browser surface needs a key or a session' };
    const target = reference();
    if (!target.ok) return { ok: false, message: target.message };
    const result = createContentSurface({
      minimized,
      params: {
        surfaceType: 'browser',
        renderMode: 'ab-screencast',
        ...(session !== undefined ? { session } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(url !== undefined ? { url } : {}),
        ...refreshedParams,
      },
      reference: target.value,
      title,
      // `dor ab` opens the screencast in the background; caller keeps focus.
      focusNeutral: true,
    });
    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      status: result.value.status,
      surfaceId: result.value.id,
      surfaceRef: result.value.ref,
      minimized,
    };
  }, [createContentSurface, findAgentBrowserSurface, updateSurfaceParams, surfaceRefForId]);

  // The pane context menu's "connect a port" action, bound to this hook's
  // closure so Wall.tsx delegates in one line instead of re-threading the
  // hook's internals. The pane is created eagerly and session-less so it appears
  // instantly; `connectPortToDefaultBrowser` then hands it its session +
  // stream port (docs/specs/dor-browser.md → Pane Context Menu Connect).
  // Failures are logged, not returned — the menu closes before one can exist.
  const connectPort = useCallback((id: string, url: string): Promise<void> => {
    const ensureEagerSurface = (session: string): ParseResult<{ surfaceId: string }> => {
      // Every arm below ends on the same surface id, and a menu click is a human
      // asking to *see* that surface — so reveal it (reattach if minimized, then
      // select). `dor ab`'s control path stays focus-neutral; this one does not.
      const reveal = (surfaceId: string): ParseResult<{ surfaceId: string }> => {
        revealSurface(surfaceId);
        return { ok: true, value: { surfaceId } };
      };
      // (a) A surface already bound to this session — reuse; params untouched
      // (the navigation + final refresh handle the rest).
      const existing = findAgentBrowserSurface(session);
      if (existing) return reveal(existing.id);
      // (b) A still-booting default pane from a rapid earlier connect (created
      // but not yet handed its session) — reuse it so a second click during the
      // daemon boot doesn't spawn a duplicate.
      const booting = findSurfaceByParams((params) =>
        isAgentBrowserParams(params)
        && (params as { key?: unknown }).key === 'default'
        && (params as { session?: unknown }).session === undefined);
      if (booting) return reveal(booting.id);
      // (c) Create it now: NO `session` (keeps the controller's stale-port
      // recovery inert until the daemon is up), but carry the target `url` so
      // the browser chrome shows it immediately.
      const created = ensureAgentBrowserSurface({
        key: 'default',
        url,
        reference: () => {
          const surface = buildDorSurfaces().find((candidate) => candidate.id === id);
          return surface ? { ok: true, value: surface } : { ok: false, message: `surface for pane '${id}' was not found` };
        },
      });
      if (!created.ok) return created;
      return reveal(created.surfaceId);
    };
    return connectPortToDefaultBrowser({
      url,
      platform: getPlatform(),
      binaryPath: lastAgentBrowserBinaryPathRef.current,
      ensureEagerSurface,
      refreshSurface: updateSurfaceParams,
    }).then((outcome) => {
      // The menu no longer surfaces errors (it closes instantly); log a failure
      // the way the render-swap path in Wall.tsx does.
      if (!outcome.ok) console.warn('[dormouse] connect port failed:', outcome.message);
    });
  }, [buildDorSurfaces, ensureAgentBrowserSurface, findAgentBrowserSurface, findSurfaceByParams, updateSurfaceParams, revealSurface, lastAgentBrowserBinaryPathRef]);

  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<DorControlRequest>).detail;
      if (!detail) return;

      const params = detail.params ?? {};
      if (!isSingletonWorkspaceTarget(params.workspace)) {
        detail.respond({ ok: false, error: `unsupported workspace target '${params.workspace}'` });
        return;
      }
      if (!isSingletonWindowTarget(params.window)) {
        detail.respond({ ok: false, error: `unsupported window target '${params.window}'` });
        return;
      }

      // Resolve the split reference surface across listed Surfaces. A minimized
      // reference is valid: the Wall creates the new split as a sibling Door.
      const resolveSplitTarget = () => {
        const target = resolveListedSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return null;
        }
        return { target: target.value };
      };

      // The `direction: 'auto'` aspect-ratio split resolution.
      const autoDorDirection = (surface: DorSurface): DorResolvedSplitDirection =>
        nav.hasPane(surface.id) ? dorDirectionForEdge(lath.store.autoEdgeFor(surface.id)) : 'right';

      if (detail.method === SURFACE_CONTROL_METHODS.list) {
        const matched = buildDorSurfaceList()
          .filter((surface) => matchesDorSurfaceTarget(params.pane, surface, detail.surfaceId));
        const surfaces = booleanParam(params.includePorts)
          ? await attachSurfacePorts(matched)
          : matched;
        detail.respond({
          ok: true,
          result: {
            surfaces,
            workspaceRef: 'workspace:1',
            windowRef: 'window:1',
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.split) {
        const directionParam = parseDorSplitDirection(params.direction);
        if (!directionParam) {
          detail.respond({ ok: false, error: `invalid split direction '${String(params.direction)}'` });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = directionParam === 'auto'
          ? autoDorDirection(resolved.target)
          : directionParam;
        const command = dorCommandString(stringArrayParam(params.command));
        if (params.command !== undefined && !command) {
          detail.respond({ ok: false, error: 'command cannot be empty' });
          return;
        }
        const result = createSplitSurface({
          command,
          direction,
          minimized: booleanParam(params.minimized),
          reference: resolved.target,
          // The CLI computes the focus intent — a bare `dor split` steals focus;
          // a `--` tail or an initial command does not — and sends it as
          // focusNeutral. Honor it.
          focusNeutral: booleanParam(params.focusNeutral),
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: 'created',
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            direction,
            minimized: result.value.minimized,
            ...(command ? { command } : {}),
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.ensure) {
        const command = dorCommandString(stringArrayParam(params.command));
        if (!command) {
          detail.respond({ ok: false, error: 'command cannot be empty' });
          return;
        }
        const cwd = stringParam(params.cwd)?.trim();
        if (!cwd) {
          detail.respond({ ok: false, error: 'cwd is required' });
          return;
        }
        const existingId = findSurfaceIdRunningCommand(command, cwd);
        if (existingId) {
          const minimized = doorsRef.current.some((door) => door.id === existingId);
          if (booleanParam(params.restart)) {
            const restarted = await restartSurfaceInPlace(existingId, command, cwd);
            if (!restarted.ok) {
              detail.respond({ ok: false, error: `surface '${surfaceRefForId(existingId)}' ${restarted.message}` });
              return;
            }
            detail.respond({
              ok: true,
              result: {
                status: 'restarted',
                surfaceId: existingId,
                surfaceRef: surfaceRefForId(existingId),
                command,
                cwd,
                minimized,
              },
            });
            return;
          }
          detail.respond({
            ok: true,
            result: {
              status: 'existing',
              surfaceId: existingId,
              surfaceRef: surfaceRefForId(existingId),
              command,
              cwd,
              minimized,
            },
          });
          return;
        }
        // ensure needs OSC 633 to track the command. cmd.exe provably has none,
        // so when the configured shell is explicitly cmd, fail immediately without
        // even spawning a split. Only short-circuit on an explicit shell — an
        // unset shell classifies as 'cmd' on Windows but the sidecar may actually
        // spawn PowerShell, so let those fall through to the generic OSC wait.
        const ensureShell = getDefaultShellOpts()?.shell;
        if (ensureShell && shellCommandKind(ensureShell, PLATFORM_STRING) === 'cmd') {
          detail.respond({ ok: false, error: missingIntegrationError(ensureShell) });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = autoDorDirection(resolved.target);
        const result = createSplitSurface({
          command,
          direction,
          minimized: booleanParam(params.minimized),
          reference: resolved.target,
          cwd,
          requireIntegration: true,
          // ensure never steals focus from the caller, matched or freshly created.
          focusNeutral: true,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        // ensure is only useful if the new shell reports OSC 633 — otherwise it
        // can never be matched or restarted. A non-cmd shell can still lack
        // integration (misconfigured, exotic); wait for the signal, and if it
        // never arrives kill the throwaway split and fail cleanly rather than
        // half-run an untrackable command. typeCommandWhenPromptReady drops the
        // command in the same case, so nothing executes.
        const integrated = await waitForTerminalState(
          result.value.id,
          () => isPaneOscDriven(result.value.id),
          INTEGRATION_DETECT_TIMEOUT_MS,
        );
        if (!integrated) {
          // Tear down the throwaway split. The focus-neutral create never selected
          // it, so the kill's live selection check leaves the caller's selection
          // where ensure found it. A `--minimize` create is already a door;
          // killPaneImmediately tears the door down too — disposing the session and
          // removing it from the baseboard.
          killPaneImmediately(result.value.id);
          detail.respond({ ok: false, error: missingIntegrationError(ensureShell) });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: 'created',
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            command,
            cwd,
            minimized: result.value.minimized,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.send) {
        const input = stringParam(params.input);
        if (input === undefined) {
          detail.respond({ ok: false, error: 'input is required' });
          return;
        }
        const target = requireTerminalSurface(params.surface, detail);
        if (!target) return;
        getPlatform().writePty(target.id, input);
        detail.respond({
          ok: true,
          result: {
            status: 'sent',
            surfaceId: target.id,
            surfaceRef: target.ref,
            inputCount: typeof params.inputCount === 'number' ? params.inputCount : 1,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.read) {
        const target = requireTerminalSurface(params.surface, detail);
        if (!target) return;
        const lines = numberParam(params.lines);
        const scrollback = booleanParam(params.scrollback);
        const text = readSurfaceText(target.id, lines, scrollback);
        detail.respond({
          ok: true,
          result: {
            workspaceRef: 'workspace:1',
            surfaceId: target.id,
            surfaceRef: target.ref,
            text,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.kill) {
        const confirmation = killConfirmationParam(params.confirmation);
        if (!confirmation) {
          detail.respond({ ok: false, error: 'invalid kill confirmation' });
          return;
        }
        const target = requireListedSurface(params.surface, detail);
        if (!target) return;
        if (confirmation.mode === 'if-read') {
          const text = readSurfaceText(target.id, undefined, false);
          if (!text.includes(confirmation.text)) {
            detail.respond({ ok: false, error: `surface '${target.ref}' read text did not contain confirmation text` });
            return;
          }
        }
        killPaneImmediately(target.id);
        detail.respond({
          ok: true,
          result: {
            status: 'killed',
            surfaceId: target.id,
            surfaceRef: target.ref,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.iframe) {
        const url = stringParam(params.url);
        if (!url) {
          detail.respond({ ok: false, error: 'url is required' });
          return;
        }
        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        const result = createContentSurface({
          minimized: booleanParam(params.minimized),
          params: { surfaceType: 'browser', renderMode: 'iframe', url },
          reference: target.value,
          title: hostPathDisplay(url, true),
          // `dor iframe` opens the embed in the background; caller keeps focus.
          focusNeutral: true,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: result.value.status,
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            url,
            minimized: booleanParam(params.minimized),
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.agentBrowser) {
        const session = stringParam(params.session);
        if (!session) {
          detail.respond({ ok: false, error: 'session is required' });
          return;
        }
        const result = ensureAgentBrowserSurface({
          key: stringParam(params.key),
          session,
          wsPort: numberParam(params.wsPort),
          binaryPath: stringParam(params.binaryPath),
          reference: () => resolveVisibleSurface(stringParam(params.surface), detail.surfaceId),
          minimized: booleanParam(params.minimized),
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: result.status,
            surfaceId: result.surfaceId,
            surfaceRef: result.surfaceRef,
            session,
            minimized: result.minimized,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.resolveOpen) {
        // Resolve a terminal Surface handle to the dev-server URL it owns, for
        // `dor ab open <surface>` / `dor iframe <surface>`. Same port scan as
        // `dor list --ports`; minimized doors are valid targets. Only terminals
        // own ports, so a browser-surface target is rejected by the guard.
        const target = requireTerminalSurface(params.surface, detail);
        if (!target) return;
        let ports: OpenPort[];
        try {
          ports = await getPlatform().getOpenPorts(target.id);
        } catch {
          ports = [];
        }
        // Group every TCP listener into one openable URL per distinct port
        // (loopback-reachable bind wins localhost; otherwise the bound
        // LAN/Tailnet address). Shared with the pane context menu's port list.
        const entries = listenerUrlsByPort(ports);
        if (entries.length === 0) {
          detail.respond({ ok: false, error: `surface '${target.ref}' is not serving any port` });
          return;
        }
        if (entries.length > 1) {
          detail.respond({
            ok: false,
            error: `surface '${target.ref}' is serving multiple ports (${entries.map((entry) => entry.port).join(', ')}); open one explicitly, e.g. http://localhost:${entries[0].port}`,
          });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            surfaceId: target.id,
            surfaceRef: target.ref,
            port: entries[0].port,
            url: entries[0].url,
          },
        });
        return;
      }

      detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
    };

    window.addEventListener('dormouse:control-request', handler);
    return () => window.removeEventListener('dormouse:control-request', handler);
  }, [buildDorSurfaces, buildDorSurfaceList, createContentSurface, createSplitSurface, ensureAgentBrowserSurface, findSurfaceIdRunningCommand, killPaneImmediately, requireListedSurface, requireTerminalSurface, resolveListedSurface, resolveVisibleSurface, surfaceRefForId, lath, nav]);

  return { connectPort };
}
