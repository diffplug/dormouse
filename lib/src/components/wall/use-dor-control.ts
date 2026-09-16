import { createSerialQueue } from '../../host/remote/serial-queue';
import { useCallback, type MutableRefObject } from 'react';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { getPlatform, PLATFORM_STRING } from '../../lib/platform';
import { currentWindowRef, getActiveWorkspaceId } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';
import type { DorControlRequestPayload, DorControlResult } from 'dor/protocol';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import type {
  Surface as DorSurface,
  SplitDirection as DorSplitDirection,
  ResolvedSplitDirection as DorResolvedSplitDirection,
  ParseResult,
  ToolSurfaceResponse,
} from 'dor/commands/types';
import { hasBrowser, hasTerminal } from 'dor/commands/types';
import { MAX_AWAIT_TIMEOUT_MS } from '../../lib/alert-manager';
import { TOOLS_FLAG_KEY, isToolsEnabled } from '../../lib/feature-flags';
import type { OpenPort } from '../../lib/platform/types';
import type { ToolKeyScope } from '../../lib/platform/tool-types';
import { buildShellCommandForKind, hasShellInputControls, shellCommandKind } from 'dor/commands/shell-quote';
import {
  UNNAMED_PANEL_TITLE,
  getDefaultShellOpts,
  getTerminalInstance,
  getTerminalPaneState,
  getTerminalShellKind,
  isPaneOscDriven,
} from '../../lib/terminal-registry';
import { cwdPathsEqual, surfaceRunsCommand, type TerminalPaneState } from '../../lib/terminal-state';
import { isAllowedAgentBrowserBinary } from '../../lib/agent-browser-binary';
import { getHelper } from '../../lib/helper-terminal';
import { isSurfaceClosing } from '../../lib/notepad/notepad-store';
import { clearToolAnnounce } from '../../lib/tool-announce-store';
import { isWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { stringParam } from './dor-control-shared';
import {
  callerStillPlaceable,
  callerStillRunnable,
  toolRerunsInCaller,
  toolTakesOverCaller,
  type ToolTakeoverGate,
} from './tool-takeover';
import { attachSurfacePorts } from './surface-ports';
import { browserSurfaceUrl, hostPathDisplay } from './browser-url';
import {
  agentBrowserSessionFromParams,
  namespacedToolKey,
  surfaceKindFromParams,
  toolKeysEqual,
  toolPendingFromParams,
  toolScopeFromParams,
  type ToolPending,
} from './browser-surface';

import { listenerUrlsByPort } from './port-url';
import { dorDirectionForEdge, toolLeafMeta, type LathWallEngine } from './lath-wall-engine';
import type { WallNav } from './keyboard/types';
import { toolCommandFromParams } from '../../lib/session-save';
import type { LeafMeta } from '../../lib/lath/persistence';
import type { CloseSurfaceMode, DooredItem } from './wall-types';

/** The params a Wall reads. The Window-level params (`scope`, and the container
 *  verbs' own) are the router's, not a Wall's: `WindowControlParams` in
 *  `workspace-control.ts`. */
export type DorControlParams = {
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
  timeoutMs?: unknown;
  until?: unknown;
  restart?: unknown;
  binaryPath?: unknown;
  includePorts?: unknown;
  pane?: string;
  session?: unknown;
  surface?: unknown;
  url?: unknown;
  // Container refs arrive unvalidated like every other param; the router types
  // them before use (`dor-control-router.ts`).
  workspace?: unknown;
  window?: unknown;
  scrollback?: unknown;
  wsPort?: unknown;
  name?: unknown;
  fresh?: unknown;
  args?: unknown;
  global?: unknown;
  file?: unknown;
  tool?: unknown;
};

// The webview view of a control request: the shared wire payload, but with
// semantically-typed params, a `respond` callback the transport layer wires back
// to the request's `requestId`, and a `signal` that fires when the request is
// cancelled — the `dor` client hung up, or the control server's deadline passed.
// A handler that parks (a long `dor await`) must listen to it and release
// whatever it armed; nothing it responds with afterwards can reach the client.
// Both are supplied by `lib/src/lib/platform/dor-control-dispatch.ts`.
export type DorControlRequest = Omit<DorControlRequestPayload, 'params'> & {
  params?: DorControlParams;
  respond: (response: DorControlResult) => void;
  /** Absent on the in-process dispatch path (and in tests), which has no
   *  client to hang up — every consumer must treat it as optional. */
  signal?: AbortSignal;
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

/**
 * What a `dor` Surface target names, in the one grammar
 * `docs/specs/dor-cli.md` → "Handle Model" defines. `stable` is the only kind
 * that identifies a Surface Window-wide, which is what lets the router send a
 * request to whichever Workspace holds it; `ref` is Workspace-scoped (every
 * Workspace has a `surface:1`), and `nothing` is a target that names no
 * Surface at all (a bare `surface:`).
 */
export type SurfaceTargetKind =
  | { kind: 'title'; title: string }
  | { kind: 'self' }
  | { kind: 'focused' }
  | { kind: 'ref'; ref: string }
  | { kind: 'stable'; id: string }
  | { kind: 'nothing' };

const POSITIONAL_SURFACE_REF = /^\d+$/;

/** Classify a target once, for the matcher below and for the router's routing
 *  decision (`dor-control-router.ts`). */
export function classifySurfaceTarget(target: string): SurfaceTargetKind {
  if (target.startsWith('title:')) return { kind: 'title', title: target.slice('title:'.length) };
  if (target === 'surface:focused') return { kind: 'focused' };
  if (target === 'surface:self') return { kind: 'self' };
  if (!target.startsWith('surface:')) return { kind: 'stable', id: target };
  const rest = target.slice('surface:'.length);
  if (!rest) return { kind: 'nothing' };
  return POSITIONAL_SURFACE_REF.test(rest) ? { kind: 'ref', ref: target } : { kind: 'stable', id: rest };
}

function matchesTarget(
  classified: SurfaceTargetKind,
  surface: DorSurface,
  callerSurfaceId: string | undefined,
): boolean {
  switch (classified.kind) {
    case 'focused':
      return surface.focused;
    case 'self':
      return callerSurfaceId !== undefined && surface.id === callerSurfaceId;
    case 'ref':
      return classified.ref === surface.ref;
    case 'stable':
      return classified.id === surface.id;
    case 'title':
      return surface.title === classified.title;
    // What a bare `surface:` names.
    case 'nothing':
      return false;
  }
}

/** Whether one Surface answers a target; an absent target matches every one. */
function matchesDorSurfaceTarget(
  target: string | undefined,
  surface: DorSurface,
  callerSurfaceId: string | undefined,
): boolean {
  return !target || matchesTarget(classifySurfaceTarget(target), surface, callerSurfaceId);
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
  // A caller this Wall does not hold never reaches here as one: the router
  // drops it before dispatching (`dor-control-router.ts`), so an omitted target
  // falls back to this Workspace's focused Surface.
  const resolvedTarget = target ?? callerSurfaceId ?? 'surface:focused';
  const classified = classifySurfaceTarget(resolvedTarget);
  const matches = surfaces.filter((surface) => matchesTarget(classified, surface, callerSurfaceId));
  const single = pickSingleMatch(matches, resolvedTarget);
  if (single) return single;
  // A title names a Surface the user can see; there is no falling back to
  // another one when it names none.
  if (classified.kind === 'title') {
    return { ok: false, message: `surface target '${resolvedTarget}' was not found` };
  }
  const fallback = !target && !callerSurfaceId ? (surfaces[0] ?? null) : null;
  if (fallback) return { ok: true, value: fallback };
  return { ok: false, message: `surface '${resolvedTarget}' was not found` };
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
const TERMINAL_STATE_POLL_MS = 100;
const PROMPT_RETURN_TIMEOUT_MS = 15_000;
const COMMAND_START_TIMEOUT_MS = 15_000;

/**
 * Serialize Tool requests and approval completions across lookup, key matching,
 * creation, and startup. Module scope shares the queue across control requests
 * and Walls in this renderer.
 */
export const queueToolSpawn = createSerialQueue();

type WaitOutcome = 'ready' | 'timeout' | 'aborted';

/** Resolve once `predicate` holds for the surface's live state, the timeout
 *  passes, or `signal` aborts — whichever comes first. */
function waitForTerminalState(
  id: string,
  predicate: (state: TerminalPaneState) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (predicate(getTerminalPaneState(id))) return Promise.resolve('ready');
  return new Promise((resolve) => {
    let elapsed = 0;
    const finish = (outcome: WaitOutcome) => {
      clearInterval(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(outcome);
    };
    const cancel = () => finish('aborted');
    const timer = setInterval(() => {
      if (predicate(getTerminalPaneState(id))) {
        finish('ready');
      } else if ((elapsed += TERMINAL_STATE_POLL_MS) >= timeoutMs) {
        finish('timeout');
      }
    }, TERMINAL_STATE_POLL_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** A completed run proves startup only for this command and directory, and
 * only when it differs from the completion observed before injection. */
function completedCommandMatches(
  state: TerminalPaneState, command: string, cwd: string, previousRunId: string | null = null,
): boolean {
  return state.lastCommand !== null && state.lastCommand.id !== previousRunId
    && surfaceRunsCommand({ ...state, currentCommand: state.lastCommand }, command, cwd);
}

/** A newly spawned Tool has no earlier command history. Its first command may
 * finish before the caller starts waiting, so a matching completion counts too.
 * Hold the launch queue through this wait; integration alone precedes injection. */
export function waitForNewToolCommand(id: string, command: string, cwd: string, signal?: AbortSignal): Promise<WaitOutcome> {
  return waitForTerminalState(id, state => surfaceRunsCommand(state, command, cwd)
    || completedCommandMatches(state, command, cwd),
  COMMAND_START_TIMEOUT_MS, signal);
}

const RESTART_CANCELLED: ParseResult<undefined> = { ok: false, message: 'restart was cancelled' };
/** The control verbs that can add a Surface to the Wall. `resolveOpen` and
 *  `resolveAgentBrowser` only answer questions, and every other verb addresses a
 *  Surface that already exists. */
const CREATING_CONTROL_METHODS = new Set<string>([
  SURFACE_CONTROL_METHODS.tool,
  SURFACE_CONTROL_METHODS.split,
  SURFACE_CONTROL_METHODS.ensure,
  SURFACE_CONTROL_METHODS.iframe,
  SURFACE_CONTROL_METHODS.agentBrowser,
]);

const ENSURE_CANCELLED = 'ensure was cancelled';

/**
 * Restart a surface already running `command` in `cwd`: interrupt it (Ctrl+C),
 * wait for the shell to return to its prompt, type the command again, and wait
 * for it to go live. Drives the live PTY directly, so it works for minimized
 * doors too (their PTY keeps running). Returns a message on failure.
 */
export async function restartSurfaceInPlace(
  id: string, command: string, cwd: string, signal?: AbortSignal,
  options: { acceptCompletedRun?: boolean } = {},
): Promise<ParseResult<undefined>> {
  // Checked before the interrupt is written, not just before each wait.
  if (signal?.aborted) return RESTART_CANCELLED;
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
    PROMPT_RETURN_TIMEOUT_MS,
    signal,
  );
  // Re-check the signal itself, not only the outcome: an already-satisfied wait
  // resolves without polling, so a cancel queued before that continuation would
  // otherwise slip past and type the command.
  if (signal?.aborted || interrupted === 'aborted') return RESTART_CANCELLED;
  if (interrupted === 'timeout') return { ok: false, message: 'did not return to a prompt after interrupt' };
  const previousRun = getTerminalPaneState(id).lastCommand?.id ?? null;
  platform.writePty(id, `${command}\r`);
  const restarted = await waitForTerminalState(
    id,
    (state) => surfaceRunsCommand(state, command, cwd)
      || (options.acceptCompletedRun === true && completedCommandMatches(state, command, cwd, previousRun)),
    COMMAND_START_TIMEOUT_MS,
    signal,
  );
  if (signal?.aborted || restarted === 'aborted') return RESTART_CANCELLED;
  if (restarted === 'timeout') return { ok: false, message: 'command did not restart' };
  return { ok: true, value: undefined };
}

/**
 * The take-over handshake (docs/specs/dor-tool.md -> Take-over): `dor` is the
 * pane's foreground process until the host answers it, so the command can only
 * be typed once its own shell is back at a prompt. A shell that never comes back
 * — or a pane killed while we wait — is left exactly as it was. Shared by the
 * take-over, which transforms the pane on the way in, and a keyed re-run in the
 * tool's own pane, which does not.
 */
async function runToolInCallerPane(
  lath: LathWallEngine,
  id: string,
  tool: {
    command: string;
    cwd: string;
    /** The tool leaf to become — omitted when the pane already is this tool and
     *  is only re-running it. */
    become?: { title: string; params: Record<string, unknown> };
  },
  /** Re-read after the wait, not only before it: the Workspace can close or
   *  transfer and the pane can be killed, minimized, or moved while `dor` exits. */
  stillEligible: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const backAtPrompt = await waitForTerminalState(
    id,
    (state) => state.currentCommand === null,
    PROMPT_RETURN_TIMEOUT_MS,
    signal,
  );
  const meta = lath.getMeta(id);
  if (signal?.aborted || backAtPrompt !== 'ready' || !meta || !stillEligible()) return;
  // Whatever this Session announced under its previous command is not this run's:
  // a stale OSC 367 would hand the tool that port, or re-key it.
  clearToolAnnounce(id);
  if (tool.become) {
    // A rename the user made outlives the transformation; an untouched fallback
    // title becomes the tool's, as a spawned one would be.
    const title = meta.title === UNNAMED_PANEL_TITLE ? tool.become.title : meta.title;
    lath.store.setMeta(id, toolLeafMeta(title, tool.become.params));
  }
  const previousRun = getTerminalPaneState(id).lastCommand?.id ?? null;
  getPlatform().writePty(id, `${tool.command}\r`);
  // The caller holds the spawn lock until this resolves: a pane typed into but
  // not yet reporting reads as an idle tool, which a queued invocation of the
  // same key would interrupt and retype. It ends on either outcome — a command
  // that dies on boot (a typo, a missing `pnpm`) can start and finish between two
  // samples, and waiting out the timeout for it would pin the lock for 15s.
  await waitForTerminalState(
    id,
    (state) => surfaceRunsCommand(state, tool.command, tool.cwd)
      || completedCommandMatches(state, tool.command, tool.cwd, previousRun),
    COMMAND_START_TIMEOUT_MS,
    signal,
  );
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
 * Quote raw argv for the configured default shell, which new splits launch.
 * The same string is used for ensure matching and restart; the CLI sends argv
 * unquoted because the shell defaults live in the webview.
 */
function dorCommandString(args: string[] | undefined): string | undefined {
  if (!args || args.join('').trim() === '') return undefined;
  const shell = getDefaultShellOpts()?.shell;
  return buildShellCommandForKind(shellCommandKind(shell, PLATFORM_STRING), args);
}

/** The command a resolved Tool types into its shell: a string `run` is literal
 *  shell syntax, an argument-list `run` uses the destination Session's shell
 *  or the default shell when launching a new Session
 *  (`docs/specs/dor-tool.md` -> Declaring tools). The host guarantees a list
 *  names an executable, so the empty-argv case cannot arise. */
export function toolRunCommand(run: string | readonly string[], terminalId?: string): string {
  const kind = (terminalId ? getTerminalShellKind(terminalId) : null)
    ?? shellCommandKind(getDefaultShellOpts()?.shell, PLATFORM_STRING);
  return typeof run === 'string' ? run : buildShellCommandForKind(kind, run);
}

/**
 * The `dor` control plane: the webview handler for `dormouse:control-request`
 * events (the `surface.*` methods that back the `dor` CLI) plus its private
 * surface-resolution/query helpers. This is CLI policy — surface targeting,
 * param coercion, command quoting, restart/integration timing — not wall layout;
 * the layout primitives it drives (`createSplitSurface`, `createContentSurface`,
 * `closeSurface`, `buildDorSurfaces`, `surfaceRefForId`) are owned by the
 * Wall and injected here (docs/specs/dor-cli.md).
 */
export function useDorControl({
  lath,
  nav,
  doorsRef,
  buildDorSurfaces,
  buildDorSurfaceList,
  surfaceRefForId,
  createSplitSurface,
  createContentSurface,
  isClosingSurface,
  isClosingWorkspace,
  closeSurface,
  revealSurface,
  lastAgentBrowserBinaryPathRef,
  workspaceRef,
  workspaceScope,
}: {
  /** The Lath engine — visible-pane projection (`lath.listPanes()`), aspect-ratio
   *  split resolution (`autoEdgeFor`), and per-leaf param writes. */
  lath: LathWallEngine;
  /** The navigation/query seam; the handler only needs `hasPane`. */
  nav: WallNav;
  doorsRef: MutableRefObject<DooredItem[]>;
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
    /** Leaf metadata for the new Surface; defaults to a plain terminal. `dor
     *  tool` passes a tool leaf, which is a shell-hosted PTY exactly like a
     *  terminal but renders both capabilities. */
    leafMeta?: LeafMeta;
    /** Create the leaf but stage no shell and spawn no PTY — a pane awaiting
     *  approval (docs/specs/dor-tool.md -> Trust rule 3). */
    deferTerminal?: boolean;
  }) => ParseResult<{ id: string; ref: string; minimized: boolean }>;
  createContentSurface: (args: {
    minimized: boolean;
    params: Record<string, unknown>;
    reference: DorSurface;
    title: string;
    focusNeutral?: boolean;
  }) => ParseResult<{ id: string; ref: string; status: 'created' | 'replaced' }>;
  /** A Wall closure in flight, independent of another caller freezing notes. */
  isClosingSurface: (id: string) => boolean;
  /** Whether this Wall's Workspace is being closed. */
  isClosingWorkspace: () => boolean;
  /** The user-visible closure path: archive the Surface's notes, then tear it
   *  down. A string means the closure was refused, and is why; the Surface is
   *  still here. */
  closeSurface: (id: string, mode?: CloseSurfaceMode) => Promise<string | null>;
  /** Reveal a Surface (reattaching a Door first) and report whether it ended up
   *  visible. `Wall.tsx` -> `revealSurface`. */
  revealSurface: (id: string) => boolean;
  /** The last binary path a `dor ab` surface resolved on a terminal's PATH. */
  lastAgentBrowserBinaryPathRef: MutableRefObject<string | undefined>;
  /** This Wall's own positional Workspace ref, reported by `dor list` so a caller
   *  learns which Workspace answered (docs/specs/dor-cli.md → "Handle Model").
   *  The Window's own ref rides beside it, so `dor list` says which Window
   *  answered too (`currentWindowRef`). */
  workspaceRef: () => string;
  /** This Wall's Workspace id, which namespaces the managed `dor ab --key`
   *  sessions it answers for; `undefined` on a bare Wall, whose keys keep the
   *  unscoped names (docs/specs/dor-browser.md → Managed identity). */
  workspaceScope: () => WorkspaceId | undefined;
}): {
  /** The live surface (visible pane or minimized door) whose params match, or
   *  null. Shared with the context's port launches in Wall.tsx. */
  findSurfaceByParams: (isMatch: (params: unknown) => boolean) => { id: string; minimized: boolean } | null;
  /** Fold a params patch onto a surface (visible pane or minimized door) — the
   *  one write path a background daemon boot uses to hand a session-less pane
   *  its `{session, wsPort, binaryPath}`. */
  updateSurfaceParams: (id: string, patch: Record<string, unknown>) => void;
  /** Run one `dor` request against this Wall. `dor-control-router.ts` owns the
   *  window listener that chooses which Wall's handler runs. */
  handleDorControl: (detail: DorControlRequest) => void;
} {
  const resolveVisibleSurface = useCallback((
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => resolveSurfaceTarget(buildDorSurfaces(), target, callerSurfaceId), [buildDorSurfaces]);

  const resolveListedSurface = useCallback((
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => resolveSurfaceTarget(buildDorSurfaceList(), target, callerSurfaceId), [buildDorSurfaceList]);

  // The shared prelude of every handler that acts on an existing surface
  // (send / read / await / kill / resolve*): a target surface is required and
  // must resolve against the listed surfaces — minimized ones included.
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

  // requireListedSurface plus the capability gate shared by the handlers that
  // read/write/scan a shell (send / read / await / resolveOpen): these are
  // terminal-gated operations (docs/specs/glossary.md → Panes and Surfaces).
  // Responds and returns null on a target with no terminal so the caller just
  // bails.
  const requireTerminalSurface = useCallback((
    surfaceParam: unknown,
    detail: DorControlRequest,
  ): DorSurface | null => {
    const target = requireListedSurface(surfaceParam, detail);
    if (!target) return null;
    if (!hasTerminal(target.kind)) {
      detail.respond({ ok: false, error: `surface '${target.ref}' has no terminal (kind: ${target.kind})` });
      return null;
    }
    return target;
  }, [requireListedSurface]);

  // The browser half of the same gate, for `dor ab --surface` (browser-gated;
  // docs/specs/glossary.md → Panes and Surfaces). Minimized targets pass: a
  // parked ab surface keeps its daemon session alive.
  const requireBrowserSurface = useCallback((
    surfaceParam: unknown,
    detail: DorControlRequest,
  ): DorSurface | null => {
    const target = requireListedSurface(surfaceParam, detail);
    if (!target) return null;
    if (!hasBrowser(target.kind)) {
      detail.respond({ ok: false, error: `surface '${target.ref}' has no browser (kind: ${target.kind})` });
      return null;
    }
    return target;
  }, [requireListedSurface]);

  /** A Surface a command may still target: not mid-fade, and not mid-closure
   *  (`closeSurface` archives before it tears down; a match made meanwhile
   *  would be acted on moments before it vanishes). */
  const isTargetable = useCallback((id: string) => !lath.isDying(id) && !isClosingSurface(id), [lath, isClosingSurface]);

  const findSurfaceIdRunningCommand = useCallback((command: string, cwdPath: string): string | null => {
    const ids = [
      ...lath.listPanes().map((panel) => panel.id),
      ...doorsRef.current.map((door) => door.id),
    ];
    return ids.find((id) => isTargetable(id) && surfaceRunsCommand(getTerminalPaneState(id), command, cwdPath)) ?? null;
  }, [lath, isTargetable]);

  /**
   * The surface (visible pane or minimized door — panes win) whose params match,
   * derived from panel/door params rather than kept as separate state so it
   * survives webview reloads. Null when nothing matches.
   */
  const findSurfaceByParams = useCallback((isMatch: (params: unknown) => boolean): { id: string; minimized: boolean } | null => {
    const panel = lath.listPanes().find((candidate) => isTargetable(candidate.id) && isMatch(candidate.params));
    if (panel) return { id: panel.id, minimized: false };
    const door = doorsRef.current.find((candidate) => isTargetable(candidate.id) && isMatch(lath.getMeta(candidate.id)?.params));
    if (door) return { id: door.id, minimized: true };
    return null;
  }, [lath, isTargetable]);

  /** The agent-browser session ↔ surface registry: the surface bound to
   *  `session`, or null if none exists. */
  const findAgentBrowserSurface = useCallback((session: string) => findSurfaceByParams(
    (params) => agentBrowserSessionFromParams(params) === session,
  ), [findSurfaceByParams]);

  // Fold a params patch onto a surface, pane or door alike — the store holds both,
  // so there is one write path. Shared by `ensureAgentBrowserSurface`'s reuse arm and
  // the context's port launches in Wall.tsx. A no-op on an empty patch.
  const updateSurfaceParams = useCallback((id: string, patch: Record<string, unknown>) => {
    if (Object.keys(patch).length === 0) return;
    lath.store.updateParams(id, patch);
  }, [lath]);

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


  // The request handler itself. The window listener that picks WHICH Wall runs it
  // lives in `dor-control-router.ts`, so exactly one Workspace answers.
  const handleDorControl = useCallback(async (detail: DorControlRequest) => {
    const params = detail.params ?? {};

    // A Workspace being closed takes no new Surfaces: `closeAll` walks its
    // members, and one created behind the walk would ride the Wall's unmount out
    // as an Orphaned Session (docs/specs/glossary.md → "Invariants" I4).
    if (CREATING_CONTROL_METHODS.has(detail.method) && isClosingWorkspace()) {
      detail.respond({ ok: false, error: 'this workspace is closing' });
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
          workspaceRef: workspaceRef(),
          windowRef: currentWindowRef(),
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

    if (detail.method === SURFACE_CONTROL_METHODS.tool) {
      // Serialize every tool request behind the last one. Each `dor`
      // invocation is its own socket connection, so two handlers otherwise
      // interleave across the host lookup, both clear the key check, and both
      // create — two panes with one key, two servers on one port.
      await queueToolSpawn(async () => {
        // Lookup and the launch lock can outlive the Workspace's close gesture.
        const scope = workspaceScope();
        const workspaceGone = () => scope && isWorkspaceTransferPending(scope) ? 'this workspace is transferring'
          : isClosingWorkspace() ? 'this workspace is closing' : null;
        const unavailable = () => {
          const error = detail.signal?.aborted ? 'tool launch cancelled' : workspaceGone();
          if (error) detail.respond({ ok: false, error });
          return error !== null;
        };
        if (unavailable()) return;
        // Off by default. With the flag off nothing is ever designated a tool,
        // so the serving trigger has nothing to watch and no pane can transform.
        if (!isToolsEnabled()) {
          detail.respond({
            ok: false,
            error: `Dor Tools are off. Enable them by setting localStorage '${TOOLS_FLAG_KEY}' to 'true'.`,
          });
          return;
        }
        const cwd = stringParam(params.cwd)?.trim();
        if (!cwd) {
          detail.respond({ ok: false, error: 'cwd is required' });
          return;
        }
        let toolName = stringParam(params.name)?.trim();
        const openFile = stringParam(params.file);
        const opening = openFile !== undefined;
        if (opening && (params.name !== undefined || params.command !== undefined || params.args !== undefined)) {
          detail.respond({ ok: false, error: 'open accepts a file and optional tool, not a command' });
          return;
        }
        let command: string;
        let toolRun: string | readonly string[];
        let key: string[] | null = null;
        let toolScope: ToolKeyScope | undefined;
        const toolArgs = stringArrayParam(params.args) ?? [];
        let warnings: string[] = [];
        let render: 'iframe' | 'ab-screencast' = 'iframe';
        // `dor tool -- <command>` has nowhere to declare a strategy, so it
        // autobinds. Safe by construction now that `auto` refuses two ports
        // rather than tie-breaking; a declared tool opts in with one line.
        let port: 'announced' | 'auto' = 'auto';
        const toolShell = getDefaultShellOpts()?.shell;
        /** Approval and spawn both require an OSC 633-integrated shell. */
        const refuseCmdShell = (): boolean => {
          if (!toolShell || shellCommandKind(toolShell, PLATFORM_STRING) !== 'cmd') return false;
          detail.respond({ ok: false, error: missingIntegrationError(toolShell) });
          return true;
        };
        // `key` and `warnings` are read when called, after the lookup fills them.
        const respondTool = (
          status: ToolSurfaceResponse['status'],
          surface: { surfaceId: string; surfaceRef?: string; command: string; cwd: string; minimized: boolean },
        ) => detail.respond({
          ok: true,
          result: {
            status,
            surfaceId: surface.surfaceId,
            surfaceRef: surface.surfaceRef ?? surfaceRefForId(surface.surfaceId),
            command: surface.command,
            cwd: surface.cwd,
            minimized: surface.minimized,
            key,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        });
        // What both placements read of the pane `dor` ran in, before the prompt
        // wait and again after it (docs/specs/dor-tool.md -> Take-over).
        const readCallerGate = (id: string, toolCwd: string): ToolTakeoverGate => {
          const state = getTerminalPaneState(id);
          return {
            verb: opening ? 'open' : 'tool',
            explicitSurface: stringParam(params.surface) !== undefined,
            minimized: booleanParam(params.minimized),
            workspaceActive: !scope || getActiveWorkspaceId() === scope,
            visible: nav.hasPane(id) && !lath.isDying(id) && !isSurfaceClosing(id),
            kind: surfaceKindFromParams(lath.getMeta(id)?.params),
            oscDriven: isPaneOscDriven(id),
            rawCommandLine: state.currentCommand?.rawCommandLine ?? null,
            cwdMatches: cwdPathsEqual(state.cwd?.path, toolCwd),
            helperPresent: !!getHelper(id),
          };
        };

        if (toolName || opening) {
          // The registry, the closed substitution set, and the trust gate all
          // live behind this one host call (`dor/commands/types` ->
          // ToolSurfaceRequest).
          const toolControl = getPlatform().toolControl;
          if (!toolControl) {
            detail.respond({ ok: false, error: 'this host cannot read a dormouse.yml; use `dor tool -- <command>`' });
            return;
          }
          const lookup = await toolControl(opening
            ? { op: 'open', target: openFile, cwd, tool: stringParam(params.tool) }
            : { op: 'lookup', name: toolName!, cwd, args: toolArgs, global: booleanParam(params.global) });
          if (unavailable()) return;
          switch (lookup.status) {
            case 'trust-recorded':
              // Only a `trust` op can produce this; a lookup never does.
              detail.respond({ ok: false, error: 'unexpected tool host response' });
              return;
            case 'ok':
              toolRun = lookup.run;
              command = toolRunCommand(lookup.run);
              toolScope = lookup.scope;
              toolName = lookup.name;
              // Namespaced under the host-resolved tool name, so two tools in
              // one repo with scope-only keys stay distinct and a runtime
              // re-key cannot name another tool's key.
              key = namespacedToolKey(lookup.name, lookup.key);
              render = lookup.render;
              port = lookup.port;
              warnings = lookup.warnings;
              break;
            case 'no-file':
              detail.respond({ ok: false, error: `no dormouse.yml found in '${cwd}' or any parent directory` });
              return;
            case 'unknown-tool':
              detail.respond({
                ok: false,
                error: lookup.names.length > 0
                  ? `no tool '${toolName}' in ${lookup.path} (has: ${lookup.names.join(', ')})`
                  : `no tool '${toolName}' in ${lookup.path}`,
              });
              return;
            case 'untrusted': {
              const pendingCommand = toolRunCommand(lookup.run);
              if (refuseCmdShell()) return;
              // The pane appears now and asks; the command spawns only on
              // approval (docs/specs/dor-tool.md -> Trust). Nothing from the
              // repo has executed to reach this point — the file was read and
              // parsed, which is inert, and is what lets the prompt name the
              // command it is asking about.
              //
              // A second launch of the same tool reuses the pending pane
              // rather than stacking prompts: dedupe cannot key on
              // `prespawn_dedupe` yet (the untrusted lookup withholds it), so
              // it keys on what the prompt is about.
              const matchesPending = (candidate: unknown) => {
                const waiting = toolPendingFromParams(candidate);
                return waiting?.name === lookup.name && waiting.projectRoot === lookup.projectRoot
                  && cwdPathsEqual(stringParam((candidate as { cwd?: unknown } | null)?.cwd), cwd)
                  && toolKeysEqual(waiting.args ?? [], toolArgs)
                  && Boolean(waiting.fresh) === booleanParam(params.fresh);
              };
              const already = booleanParam(params.fresh) ? null : findSurfaceByParams(matchesPending);
              if (already) {
                const revealed = revealSurface(already.id);
                respondTool('pending', {
                  surfaceId: already.id,
                  command: pendingCommand,
                  cwd,
                  minimized: !revealed,
                });
                return;
              }
              const pendingTarget = resolveSplitTarget();
              if (!pendingTarget) return;
              // Deliberately not minimized, whatever was asked: a pane the
              // user cannot see is a pane they cannot approve. The request is
              // carried and applied once they do.
              const pendingMeta: ToolPending = {
                name: lookup.name,
                run: pendingCommand,
                args: toolArgs,
                path: lookup.path,
                projectRoot: lookup.projectRoot,
                minimized: booleanParam(params.minimized),
                fresh: booleanParam(params.fresh),
                upstreamUrl: lookup.upstreamUrl,
              };
              const pending = createSplitSurface({
                direction: autoDorDirection(pendingTarget.target),
                minimized: false,
                reference: pendingTarget.target,
                cwd,
                focusNeutral: true,
                // No shell until a human approves: `createSplitSurface` would
                // otherwise stage shell opts and, on some paths, spawn the PTY
                // outright (docs/specs/dor-tool.md -> Trust rule 3).
                deferTerminal: true,
                leafMeta: toolLeafMeta(lookup.name, {
                  surfaceType: 'tool',
                  command: pendingCommand,
                  cwd,
                  toolName: lookup.name,
                  toolPending: pendingMeta,
                }),
              });
              if (!pending.ok) {
                detail.respond({ ok: false, error: pending.message });
                return;
              }
              // A minimized reference creates its sibling as a Door even
              // when `minimized` is false. Pending approval must stay visible,
              // so immediately reattach that exceptional creation path.
              const stillMinimized = pending.value.minimized && !revealSurface(pending.value.id);
              respondTool('pending', {
                surfaceId: pending.value.id,
                surfaceRef: pending.value.ref,
                command: pendingCommand,
                cwd,
                minimized: stillMinimized,
              });
              return;
            }
            default:
              detail.respond({ ok: false, error: lookup.message });
              return;
          }
        } else {
          const argv = stringArrayParam(params.command);
          if (argv?.some(hasShellInputControls)) {
            detail.respond({ ok: false, error: 'tool arguments cannot contain terminal control characters' });
            return;
          }
          command = dorCommandString(argv) ?? '';
          if (!command) {
            detail.respond({ ok: false, error: 'command cannot be empty' });
            return;
          }
          toolRun = argv!;
        }

        const toolParams = {
          surfaceType: 'tool',
          command,
          ...(typeof toolRun === 'string' ? {} : { toolArgv: [...toolRun] }),
          cwd,
          toolRender: render,
          ...(toolScope ? { toolScope } : {}),
          toolPort: port,
          ...(key ? { toolKey: key } : {}),
          ...(toolName ? { toolName } : {}),
        };

        const callerId = detail.surfaceId;
        const callerGate = callerId === undefined ? null : readCallerGate(callerId, cwd);

        // Spawn-time dedupe, and only for a tool that was given an identity
        // (docs/specs/dor-tool.md -> Identity and dedupe).
        if (key && !booleanParam(params.fresh)) {
          const matchesToolKey = (candidate: unknown) =>
            toolScopeFromParams(candidate) === toolScope
            && toolKeysEqual((candidate as { toolKey?: unknown } | null | undefined)?.toolKey, key);
          const match = findSurfaceByParams(matchesToolKey);
          if (match) {
            const matchedCommand = toolCommandFromParams(lath.getMeta(match.id)?.params) ?? toolRunCommand(toolRun, match.id);
            const matchState = getTerminalPaneState(match.id);
            // The tool's own cwd, not the caller's: `surfaceRunsCommand`
            // compares against the matched Surface's `cwdAtStart`, so waiting
            // on the caller's would never resolve when `dor tool` is run from
            // a subdirectory — the command restarts and we report failure.
            const matchedCwd = matchState.cwd?.path ?? cwd;
            // A match that is the calling pane is the tool's own Surface — the
            // place take-over makes normal to retype in. Its command is live
            // only when the tool itself spawned this `dor`; otherwise `dor` is
            // what its shell is running, so the tool is idle however its pane
            // reads, and it re-runs in its own directory like any `adopted`
            // match. Through the handshake, never `restartSurfaceInPlace`,
            // whose Ctrl+C would kill the `dor` awaiting this answer.
            if (match.id === callerId && !surfaceRunsCommand(matchState, matchedCommand, matchedCwd)) {
              if (!callerGate || !toolRerunsInCaller(callerGate)) {
                // Nothing can be typed behind a line that is not this
                // invocation alone, and there is no survivor to reveal — the
                // user is sitting in it. Say so instead of reporting a tool
                // that is not running as `existing`.
                detail.respond({
                  ok: false,
                  error: `surface '${surfaceRefForId(match.id)}' is this tool's own pane and its command is not running; re-run it by typing the invocation alone at its prompt`,
                });
                return;
              }
              revealSurface(match.id);
              respondTool('adopted', { surfaceId: match.id, command: matchedCommand, cwd: matchedCwd, minimized: false });
              await runToolInCallerPane(
                lath,
                match.id,
                { command: matchedCommand, cwd: matchedCwd },
                () => !workspaceGone() && callerStillRunnable(readCallerGate(match.id, matchedCwd)),
                detail.signal,
              );
              return;
            }
            // A dedicated Surface whose command exited is unambiguously free,
            // so re-run in place rather than splitting — where `dor ensure`,
            // aimed at arbitrary shells, would stop matching.
            const idle = matchState.currentCommand === null;
            if (idle) {
              const restarted = await restartSurfaceInPlace(match.id, matchedCommand, matchedCwd, detail.signal, { acceptCompletedRun: true });
              if (!restarted.ok) {
                detail.respond({
                  ok: false,
                  error: `surface '${surfaceRefForId(match.id)}' ${restarted.message}`,
                });
                return;
              }
            }
            // Reveal, reattaching a Door first: a match that only printed a
            // handle would leave a minimized tool minimized, which is exactly
            // the "appears to do nothing" the invariant is written against.
            const revealed = revealSurface(match.id);
            respondTool(idle ? 'adopted' : 'existing', {
              surfaceId: match.id,
              command: matchedCommand,
              cwd,
              minimized: !revealed,
            });
            return;
          }
        }

        // Take-over: typed alone at a prompt, the tool runs in the calling pane
        // rather than splitting (docs/specs/dor-tool.md -> Take-over). Must stay
        // below the pending-approval and key-match returns above: both of those
        // placements win over this one.
        if (callerId && callerGate && toolTakesOverCaller(callerGate)) {
          command = toolRunCommand(toolRun, callerId);
          toolParams.command = command;
          // Answered before the tool starts, because answering is what frees
          // the shell to run it.
          respondTool('takeover', { surfaceId: callerId, command, cwd, minimized: false });
          // Awaited inside the spawn lock: the key reaches the leaf's params in
          // there, and a queued invocation of it must find a running tool.
          await runToolInCallerPane(
            lath,
            callerId,
            { command, cwd, become: { title: toolName ?? command, params: toolParams } },
            () => !workspaceGone() && callerStillPlaceable(readCallerGate(callerId, cwd)),
            detail.signal,
          );
          return;
        }

        // A tool is a shell-hosted PTY with the command typed into it, exactly
        // as `dor ensure` spawns one — but with no command+cwd matching, and a
        // leaf that renders both capabilities.
        if (refuseCmdShell()) return;
        const toolTarget = resolveSplitTarget();
        if (!toolTarget) return;
        const created = createSplitSurface({
          command,
          direction: autoDorDirection(toolTarget.target),
          minimized: booleanParam(params.minimized),
          reference: toolTarget.target,
          cwd,
          requireIntegration: true,
          // Focus-neutral like `dor ensure`: a tool spawned by a script or an
          // agent must not steal the caller's selection.
          focusNeutral: true,
          leafMeta: toolLeafMeta(toolName ?? command, toolParams),
        });
        if (!created.ok) {
          detail.respond({ ok: false, error: created.message });
          return;
        }
        const toolIntegrated = await waitForTerminalState(
          created.value.id,
          () => isPaneOscDriven(created.value.id),
          INTEGRATION_DETECT_TIMEOUT_MS,
          detail.signal,
        );
        if (detail.signal?.aborted || toolIntegrated !== 'ready') {
          const refused = await closeSurface(created.value.id, 'silent');
          detail.respond({ ok: false, error: refused ?? (detail.signal?.aborted ? 'tool launch cancelled' : missingIntegrationError(toolShell)) });
          return;
        }
        respondTool('created', {
          surfaceId: created.value.id,
          surfaceRef: created.value.ref,
          command,
          cwd,
          minimized: created.value.minimized,
        });
        await waitForNewToolCommand(created.value.id, command, cwd, detail.signal);
      });
      return;
    }

    if (detail.method === SURFACE_CONTROL_METHODS.ensure) {
      if (detail.signal?.aborted) {
        detail.respond({ ok: false, error: ENSURE_CANCELLED });
        return;
      }
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
          const restarted = await restartSurfaceInPlace(existingId, command, cwd, detail.signal);
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
        detail.signal,
      );
      if (detail.signal?.aborted || integrated !== 'ready') {
        // The temporary pane is visible during integration detection and may
        // have acquired notes. Preserve the ordinary closure contract even
        // when the client has gone away (docs/specs/notepad.md → "Closure").
        const reason = detail.signal?.aborted || integrated === 'aborted' ? ENSURE_CANCELLED : missingIntegrationError(ensureShell);
        const refused = await closeSurface(result.value.id, 'silent');
        detail.respond({ ok: false, error: refused ? `${reason}; temporary surface kept open: ${refused}` : reason });
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
          workspaceRef: workspaceRef(),
          surfaceId: target.id,
          surfaceRef: target.ref,
          text,
        },
      });
      return;
    }

    // `dor await` — park until the Session finishes what it is doing
    // (`docs/specs/alert.md` → Await). Everything that makes this a *wait* —
    // the wake condition, the grace window, the `timeoutMs` ceiling, and the
    // absorption of the completion it consumes — lives in the host's
    // `AlertManager`; this branch only validates, parks, and reports.
    if (detail.method === SURFACE_CONTROL_METHODS.await) {
      const target = requireTerminalSurface(params.surface, detail);
      if (!target) return;
      const until = params.until;
      if (until !== 'quiet' && until !== 'exit') {
        detail.respond({ ok: false, error: `invalid await condition '${String(until)}'` });
        return;
      }
      // The host re-checks this, but a bad ceiling there settles `cancelled`
      // silently (no response ever reaches the caller); rejecting here turns
      // that into a visible error.
      const timeoutMs = numberParam(params.timeoutMs);
      if (timeoutMs === undefined || timeoutMs <= 0 || timeoutMs > MAX_AWAIT_TIMEOUT_MS) {
        detail.respond({ ok: false, error: `timeoutMs must be a positive number no greater than ${MAX_AWAIT_TIMEOUT_MS}` });
        return;
      }

      const handle = getPlatform().alertAwait(target.id, { until, timeoutMs });
      // The client hung up (Ctrl-C) or the control server's deadline passed:
      // release the wait so it stops absorbing completions nobody can receive.
      // Guarded because in-process callers may dispatch a request without one.
      detail.signal?.addEventListener('abort', () => handle.cancel());

      const outcome = await handle.promise;
      // `cancelled` has no wire outcome of its own — it means the host tore
      // the wait down (manager disposed, webview released). Answering with an
      // error rather than returning silently is what forgets the request:
      // `respond` is the only thing that clears `dor-control-dispatch`'s
      // in-flight entry, and a client that is somehow still listening gets an
      // answer instead of blocking to its own deadline.
      if (outcome.kind === 'cancelled') {
        detail.respond({ ok: false, error: `await on '${target.ref}' was cancelled by the host` });
        return;
      }
      detail.respond({
        ok: true,
        result: {
          workspaceRef: workspaceRef(),
          surfaceId: target.id,
          surfaceRef: target.ref,
          outcome: outcome.kind,
          ...(outcome.kind === 'resolved' ? { cause: outcome.cause } : {}),
          // The host measured the wait; re-measuring here would only add the
          // transport hop and disagree with what it absorbed.
          waitedMs: outcome.waitedMs,
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
      // `dor kill` is a user-visible permanent closure, so it archives the
      // Surface's notes first. A refused archive leaves the Surface running
      // and answers with the error rather than silently dropping the notes —
      // and raises no pane prompt, because the caller is a command, not
      // someone looking at the Wall (docs/specs/notepad.md → "Closure").
      const refused = await closeSurface(target.id, 'silent');
      if (refused) {
        detail.respond({ ok: false, error: refused });
        return;
      }
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
      const raw = stringParam(params.url);
      if (!raw) {
        detail.respond({ ok: false, error: 'url is required' });
        return;
      }
      // The control socket is a wire protocol, not the CLI: `dor iframe`
      // validates its argument, but anything holding the control token
      // reaches this method directly (`browserSurfaceUrl`).
      const url = browserSurfaceUrl(raw);
      if (!url) {
        detail.respond({ ok: false, error: 'url must be an http:// or https:// URL' });
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
      // `binaryPath` names a program the host will spawn and is persisted into
      // the pane's params, so it is checked before it is stored rather than
      // only at the spawn (`lib/src/lib/agent-browser-binary.ts`).
      //
      // Dropped rather than fatal, like `allowedBinaryPath` in
      // agent-browser-surface-controller.ts and `runWithBinaryFallback`: the
      // host resolves its own candidate instead, and it can accept a path
      // this realm cannot — `DORMOUSE_AGENT_BROWSER_BIN` matches by exact
      // value, and only the host can read its own environment. Refusing the
      // request here would mean no browser surface at all for an operator who
      // set that variable to a differently-named wrapper.
      const requestedBinaryPath = stringParam(params.binaryPath);
      const binaryPath = isAllowedAgentBrowserBinary(requestedBinaryPath)
        ? requestedBinaryPath
        : undefined;
      const result = ensureAgentBrowserSurface({
        key: stringParam(params.key),
        session,
        wsPort: numberParam(params.wsPort),
        binaryPath,
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
      // `dor list --ports`; minimized doors are valid targets. Ports ride the
      // terminal, so a target without one is rejected by the guard.
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

    if (detail.method === SURFACE_CONTROL_METHODS.resolveAgentBrowser) {
      // A managed `--key` names no Surface: it names this Workspace's browser of
      // that name, so the answer is the key namespaced under the Workspace that
      // will hold it (docs/specs/dor-browser.md → Managed identity). Answered
      // whether or not a Surface holds that session yet — `surface.agentBrowser`
      // is what creates or reuses one.
      const keyParam = stringParam(params.key);
      if (keyParam) {
        detail.respond({ ok: true, result: { session: sessionForKey(keyParam, workspaceScope()) } });
        return;
      }
      // Resolve a browser Surface handle to the agent-browser session bound to
      // it, for `dor ab --surface <handle> <verb...>`. Past the browser gate,
      // web verbs stay renderMode-gated: an `iframe` renderer is a browser
      // with nothing to drive (docs/specs/glossary.md → Panes and Surfaces).
      const target = requireBrowserSurface(params.surface, detail);
      if (!target) return;
      if (target.renderMode === 'iframe') {
        detail.respond({
          ok: false,
          error: `surface '${target.ref}' is not agent-browser rendered (render_mode: ${target.renderMode})`,
        });
        return;
      }
      // The session is the one row field the projection deliberately withholds
      // (it is an identifier, not a capability), so read it from the params —
      // live metadata for panes and parked doors alike.
      const session = agentBrowserSessionFromParams(lath.getMeta(target.id)?.params);
      if (!session) {
        // An eagerly-created connect pane whose daemon boot has not yet named
        // it (docs/specs/dor-browser.md → Pane Context Menu Connect).
        detail.respond({ ok: false, error: `surface '${target.ref}' has no agent-browser session yet` });
        return;
      }
      detail.respond({
        ok: true,
        result: { surfaceId: target.id, surfaceRef: target.ref, session },
      });
      return;
    }

    detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
  }, [buildDorSurfaces, buildDorSurfaceList, closeSurface, createContentSurface, createSplitSurface, ensureAgentBrowserSurface, findSurfaceIdRunningCommand, findSurfaceByParams, revealSurface, isClosingWorkspace, requireBrowserSurface, requireListedSurface, requireTerminalSurface, resolveListedSurface, resolveVisibleSurface, surfaceRefForId, lath, nav, workspaceRef, workspaceScope]);

  return { findSurfaceByParams, updateSurfaceParams, handleDorControl };
}
