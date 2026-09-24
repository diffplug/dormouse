import { POSIX_ESCAPABLE } from './posix-escape';

export type CwdSource = 'osc7' | 'osc9_9' | 'osc633' | 'osc1337' | 'process' | 'manual';
export type PathKind = 'posix' | 'windows' | 'unknown';

export interface CwdState {
  uri?: string;
  path: string;
  host?: string;
  scheme?: 'file';
  pathKind: PathKind;
  isRemote: boolean;
  source: CwdSource;
  updatedAt: number;
}

export type ShellActivity =
  | { kind: 'unknown' }
  | { kind: 'prompt' }
  | { kind: 'editing' }
  | { kind: 'running' }
  | { kind: 'finished'; exitCode?: number };

export type CommandRunSource =
  | 'osc633_E'
  | 'osc633_boundaries'
  | 'osc133_boundaries'
  | 'user_input';

export interface CommandRun {
  id: string;
  rawCommandLine: string | null;
  displayCommand: string;
  cwdAtStart: CwdState | null;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  source: CommandRunSource;
  /**
   * App-sent title (OSC 0 / 2 / 9) that was active when this command finished, snapshotted by
   * `commandFinish` so post-finish title events (e.g. the shell resetting the title to `zsh`)
   * do not overwrite the in-run title we want to show in the `<idle> ${LAST_TITLE}` header.
   * Only set on finished commands; never read before `finishedAt`.
   */
  finalTerminalTitle?: TerminalTitle;
  outputRange?: {
    startMarkId?: string;
    endMarkId?: string;
  };
}

export type TerminalTitleSource =
  | 'osc0'
  | 'osc2'
  | 'osc9'
  | 'osc99'
  | 'osc777'
  | 'user';

export interface TerminalTitle {
  title: string;
  source: TerminalTitleSource;
  updatedAt: number;
}

export type TerminalTitleCandidates = Partial<Record<TerminalTitleSource, TerminalTitle>>;

export interface TerminalPaneState {
  cwd: CwdState | null;
  activity: ShellActivity;
  pendingCommandLine: string | null;
  currentCommand: CommandRun | null;
  lastCommand: CommandRun | null;
  titleCandidates: TerminalTitleCandidates;
}

export type TerminalSemanticEvent =
  | { type: 'cwd'; cwd: CwdState }
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'commandLine'; commandLine: string }
  | { type: 'commandStart'; source?: CommandRunSource; startedAt?: number }
  | { type: 'commandFinish'; exitCode?: number; finishedAt?: number }
  | { type: 'title'; title: TerminalTitle };

export interface DirectoryDisplayOptions {
  includeHost?: 'auto' | 'always' | 'never';
  style?: 'basename' | 'short' | 'full';
  maxSegments?: number;
  homePath?: string;
}

export interface HeaderOptions extends DirectoryDisplayOptions {
  appTitleForPane?: (pane: TerminalPaneState) => string | null | undefined;
}

export interface DerivedHeader {
  primary: string;
  secondary?: string;
  // True when `primary` ends with the fail glyph because the last command
  // exited non-zero. The header uses this to color the glyph red without having
  // to re-parse it back out of the title string.
  lastCommandFailed?: boolean;
}

export type TerminalGroupingMode = 'none' | 'directory' | 'command' | 'status';

export interface TerminalGroup {
  key: string;
  label: string;
  panes: TerminalPaneState[];
}

export interface TerminalNotificationTitleLike {
  source?: string;
  title?: string | null;
  body?: string | null;
}

export const DEFAULT_TERMINAL_PANE_STATE: TerminalPaneState = Object.freeze({
  cwd: null,
  activity: Object.freeze({ kind: 'unknown' } as ShellActivity),
  pendingCommandLine: null,
  currentCommand: null,
  lastCommand: null,
  title: null,
  titleCandidates: Object.freeze({}),
});

export const DEFAULT_IDLE_TITLE = '<idle>';
// Appended to the idle title when the last command exited non-zero. Kept as a
// plain glyph in the title string so tab/OS-level titles carry it too; the pane
// header re-colors this trailing glyph red (see TerminalPaneHeader). Only shows
// when we have a real exit code — the keystroke fallback leaves exitCode unset.
export const COMMAND_FAIL_GLYPH = '✗';
export const DEFAULT_COMMAND_TITLE = 'shell';
export const UNNAMED_PANEL_TITLE = '<unnamed>';
const DEFAULT_DIRECTORY_LABEL = 'Unknown directory';
const COMMAND_TITLE_LIMIT = 48;
let nextCommandRunId = 0;

export function createTerminalPaneState(initial?: Partial<TerminalPaneState>): TerminalPaneState {
  return {
    cwd: initial?.cwd ?? null,
    activity: initial?.activity ?? { kind: 'unknown' },
    pendingCommandLine: initial?.pendingCommandLine ?? null,
    currentCommand: initial?.currentCommand ?? null,
    lastCommand: initial?.lastCommand ?? null,
    titleCandidates: { ...initial?.titleCandidates },
  };
}

export function reduceTerminalState(
  state: TerminalPaneState,
  event: TerminalSemanticEvent,
  options: { now?: () => number; createId?: () => string } = {},
): TerminalPaneState {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? createCommandRunId;

  switch (event.type) {
    case 'cwd':
      if (state.cwd && sameCwd(state.cwd, event.cwd)) return state;
      return { ...state, cwd: event.cwd };
    case 'promptStart':
      if (state.activity.kind === 'prompt' && state.pendingCommandLine === null && state.currentCommand === null) return state;
      return {
        ...state,
        activity: { kind: 'prompt' },
        currentCommand: null,
        pendingCommandLine: null,
      };
    case 'promptEnd':
      if (state.activity.kind === 'editing' && state.pendingCommandLine === null && state.currentCommand === null) return state;
      return {
        ...state,
        activity: { kind: 'editing' },
        currentCommand: null,
        pendingCommandLine: null,
      };
    case 'commandLine':
      if (state.pendingCommandLine === event.commandLine) return state;
      return { ...state, pendingCommandLine: event.commandLine };
    case 'commandStart': {
      const resolved = resolveCommandStart(state.pendingCommandLine, event, {
        now,
        fallbackTitle: () => deriveFallbackCommandTitle(state),
      });
      return {
        ...state,
        currentCommand: {
          id: createId(),
          ...resolved,
          cwdAtStart: state.cwd,
        },
        activity: { kind: 'running' },
        pendingCommandLine: null,
      };
    }
    case 'commandFinish': {
      if (!state.currentCommand) {
        const next = finishedActivity(event.exitCode);
        if (sameActivity(state.activity, next)) return state;
        return { ...state, activity: next };
      }
      const finishedAt = event.finishedAt ?? now();
      const finalTerminalTitle = snapshotInRunTerminalTitle(state, state.currentCommand, finishedAt);
      const finishedCommand: CommandRun = {
        ...state.currentCommand,
        finishedAt,
        exitCode: event.exitCode,
        ...(finalTerminalTitle ? { finalTerminalTitle } : {}),
      };
      return {
        ...state,
        currentCommand: null,
        lastCommand: finishedCommand,
        activity: finishedActivity(event.exitCode),
      };
    }
    case 'title': {
      const existing = state.titleCandidates[event.title.source];
      if (existing && sameTitle(existing, event.title)) return state;
      return {
        ...state,
        titleCandidates: {
          ...state.titleCandidates,
          [event.title.source]: event.title,
        },
      };
    }
  }
}

function sameCwd(a: CwdState, b: CwdState): boolean {
  return cwdIdentity(a) === cwdIdentity(b) && a.source === b.source;
}

function sameTitle(a: TerminalTitle, b: TerminalTitle): boolean {
  return a.title === b.title && a.source === b.source && a.updatedAt === b.updatedAt;
}

function sameActivity(a: ShellActivity, b: ShellActivity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'finished' && b.kind === 'finished') return a.exitCode === b.exitCode;
  return true;
}

export function cwdFromOsc7(rawUriInput: string, now = Date.now()): CwdState | null {
  // Bounded before the URL parse and the percent-decode, not after: every value
  // below is retained per Session (see `boundedCwdValue`).
  const rawUri = boundedCwdValue(rawUriInput);
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;

  const decodedPath = boundedCwdValue(normalizeFileUriPath(safeDecodeURIComponent(parsed.pathname)));
  // Bounded the same way `decodedPath` is. The host is retained, rendered, and
  // part of `cwdIdentity`, so it is sanitized where it is built rather than on
  // the URL parser rejecting every control character a host could decode to.
  const host = boundedCwdValue(fileUriHost(rawUri, parsed.hostname)) || undefined;
  return {
    uri: rawUri,
    path: decodedPath,
    host,
    scheme: 'file',
    pathKind: inferPathKind(decodedPath),
    isRemote: isRemoteFileHost(host),
    source: 'osc7',
    updatedAt: now,
  };
}

export function cwdFromOsc9_9(rawPath: string, now = Date.now()): CwdState | null {
  const path = boundedCwdValue(rawPath);
  if (!path) return null;
  return {
    path,
    pathKind: isWindowsPath(path) ? 'windows' : 'unknown',
    isRemote: isUncPath(path),
    source: 'osc9_9',
    updatedAt: now,
  };
}

export function cwdFromOsc633(rawPath: string, now = Date.now()): CwdState | null {
  return cwdFromDecodedPath(rawPath, 'osc633', now);
}

export function cwdFromOsc1337(rawPath: string, now = Date.now()): CwdState | null {
  return cwdFromDecodedPath(rawPath, 'osc1337', now);
}

export function cwdFromProcessPath(rawPath: string, now = Date.now()): CwdState | null {
  return cwdFromDecodedPath(rawPath, 'process', now);
}

export function cwdFromManualPath(rawPath: string, now = Date.now()): CwdState | null {
  return cwdFromDecodedPath(rawPath, 'manual', now);
}

/** Whether inspecting the live process may replace a CWD from this source. A
 *  shell integration escape is the shell's own answer and always wins; nothing
 *  reported, an earlier inspection, and a launch-time seed are all fillable.
 *  The one rule for it, so a caller can also decline to *ask*. */
export function processCwdMayReplace(source: CwdSource | undefined): boolean {
  return source === undefined || source === 'process' || source === 'manual';
}

export function cwdIdentity(cwd: CwdState): string {
  const scheme = cwd.scheme ?? 'path';
  const host = cwd.host ?? '';
  return `${scheme}|${host}|${cwd.pathKind}|${cwd.path}`;
}

export function cwdDisplay(cwd: CwdState, options: DirectoryDisplayOptions = {}): string {
  const style = options.style ?? 'short';
  const hostMode = options.includeHost ?? 'auto';
  const pathLabel = style === 'full'
    ? formatFullPath(cwd.path, options.homePath)
    : formatTrailingPath(cwd.path, cwd.pathKind, style === 'basename' ? 1 : options.maxSegments ?? 2);
  const shouldIncludeHost =
    hostMode === 'always' ||
    (hostMode === 'auto' && cwd.isRemote && !!cwd.host);
  return shouldIncludeHost && cwd.host ? `${cwd.host}:${pathLabel}` : pathLabel;
}

export function shortestUniqueCwdLabels(
  cwds: CwdState[],
  options: DirectoryDisplayOptions = {},
): Map<string, string> {
  const uniqueCwds = uniqueByIdentity(cwds);
  let labels = new Map<string, string>();
  if (uniqueCwds.length === 0) return labels;

  const maxDepth = Math.max(...uniqueCwds.map((cwd) => pathParts(cwd.path, cwd.pathKind).segments.length), 1);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const baseLabels = new Map<string, string>();
    for (const cwd of uniqueCwds) {
      baseLabels.set(cwdIdentity(cwd), formatTrailingPath(cwd.path, cwd.pathKind, depth));
    }
    labels = withRequiredHostPrefixes(uniqueCwds, baseLabels, options);
    if (findLabelCollisions(uniqueCwds, labels).size === 0) return labels;
  }

  const remainingCollisions = findLabelCollisions(uniqueCwds, labels);
  const includeHost = options.includeHost ?? 'auto';
  for (const cwd of uniqueCwds) {
    const id = cwdIdentity(cwd);
    const label = labels.get(id) ?? cwdDisplay(cwd, options);
    const needsHost =
      includeHost === 'always' ||
      (includeHost === 'auto' && (cwd.isRemote || remainingCollisions.has(label)));
    labels.set(id, needsHost && cwd.host ? `${cwd.host}:${label}` : label);
  }

  return labels;
}

export function summarizeCommandLine(raw: string): string {
  const tokens = tokenizeCommand(raw.trim());
  if (tokens.length === 0) return DEFAULT_COMMAND_TITLE;

  const commandTokens = takePrimaryCommandTokens(tokens);
  if (commandTokens.length === 0) return DEFAULT_COMMAND_TITLE;

  const hasPipeline = tokens.includes('|');
  // A lone `&` backgrounds the line, or leading it is PowerShell's call
  // operator; neither makes a second command worth the ` ...`.
  const hasCompound = tokens.some((token) => token !== '&' && LIST_SEPARATORS.has(token));
  const visibleTokens = commandTitleTokens(commandTokens);
  const suffix = hasPipeline ? ' | ...' : hasCompound ? ' ...' : '';
  // One line, though a quoted argument or a substitution may span several.
  return truncateCommandTitle(`${visibleTokens.join(' ')}${suffix}`.replace(/\s*\n\s*/g, ' '));
}

/**
 * The key WATCHING rules are stored under: the program a command line waits on,
 * as a bare name or `<runner> <script>`, or null when the line holds no
 * runnable word. Every key it returns passes {@link isWatchKey}. The rules that
 * derive it are `docs/specs/alert.md` -> WATCHING Track.
 */
export function commandWatchKey(raw: string): string | null {
  const commands = listCommands(tokenizeCommand(raw.trim()));
  const words = commands[commands.length - 1] ?? [];
  const pipe = words.indexOf('|');
  return watchKeyOfCommand(pipe === -1 ? words : words.slice(0, pipe));
}

/**
 * Whether `name` is a WATCHING key some command line can produce: a bare
 * program name, or exactly `<runner> <script>`. Neither part holds a path
 * separator, and the program never starts with a Windows drive prefix or ends
 * in a launcher suffix — `commandProgramName` strips those. A script may look
 * like a drive prefix (`npm run b:dev`).
 */
export function isWatchKey(name: string): boolean {
  const parts = name.split(' ');
  if (parts.length > 2 || parts.some((part) => !part || /[\\/\s]/.test(part))) return false;
  return !/^[A-Za-z]:/.test(parts[0]!) && !WINDOWS_EXECUTABLE_SUFFIX.test(parts[0]!);
}

/**
 * The rule in `rules` that covers `key`, or null: the key itself, else — for a
 * `<runner> <script>` key — a bare rule on its runner, which keeps matching
 * every script of that runner.
 */
export function watchRuleFor(rules: ReadonlySet<string>, key: string | null): string | null {
  if (key === null) return null;
  if (rules.has(key)) return key;
  const space = key.indexOf(' ');
  const runner = space === -1 ? null : key.slice(0, space);
  return runner !== null && rules.has(runner) ? runner : null;
}

/**
 * The tokens of the first command on a line: quote- and escape-aware, truncated
 * at the first pipeline/compound boundary, with leading `VAR=value` assignments
 * and a leading `env` skipped.
 */
export function primaryCommandTokens(raw: string): string[] {
  return takePrimaryCommandTokens(tokenizeCommand(raw.trim()));
}

export interface ResolvedCommandStart {
  rawCommandLine: string | null;
  displayCommand: string;
  source: CommandRunSource;
  startedAt: number;
}

/**
 * Turn a `commandStart` event plus the command line staged by the preceding
 * `commandLine` event into the fields a command run needs. Shared by the
 * terminal-state reducer and the alert manager's command-exit alerting so the
 * source resolution and display summarization exist in one place.
 *
 * `fallbackTitle` supplies the display label when the shell reported no command
 * line (`OSC 133;C` carries none); it defaults to `DEFAULT_COMMAND_TITLE`.
 */
export function resolveCommandStart(
  pendingCommandLine: string | null,
  event: Extract<TerminalSemanticEvent, { type: 'commandStart' }>,
  options: { now?: () => number; fallbackTitle?: () => string } = {},
): ResolvedCommandStart {
  const raw = pendingCommandLine;
  return {
    rawCommandLine: raw,
    displayCommand: raw
      ? summarizeCommandLine(raw)
      : options.fallbackTitle?.() ?? DEFAULT_COMMAND_TITLE,
    source: event.source === 'osc633_boundaries' && raw
      ? 'osc633_E'
      : event.source ?? (raw ? 'osc633_E' : 'osc133_boundaries'),
    startedAt: event.startedAt ?? (options.now ?? Date.now)(),
  };
}

// Fold the Windows spellings of one directory to a single key so `dor ensure`
// can match a surface across the dialect split. On Windows + Git Bash the shell
// integration reports its cwd as a POSIX path (`/c/Users/...`) while the `dor`
// CLI sends a native Windows path (`C:\Users\...`) for the very same folder, so
// an exact compare never matches and every ensure spawns a duplicate. This
// normalizes the MSYS drive form (`/c/` -> `C:\`), slash direction, and
// drive-letter case. It is anchored to leave genuine POSIX paths (`/Users/...`,
// `/home/...`) untouched — only a single-letter root segment, i.e. an MSYS drive,
// is rewritten — so it is a no-op on macOS/Linux. Applied symmetrically, so
// already-equal paths stay equal.
function canonicalizeCwdForMatch(path: string): string {
  const withDrive = path.replace(/^\/([A-Za-z])\//, (_match, drive: string) => `${drive}:/`);
  if (!/^[A-Za-z]:[\\/]/.test(withDrive)) return path;
  const unified = withDrive.replace(/\//g, '\\');
  return unified.charAt(0).toUpperCase() + unified.slice(1);
}

/**
 * Whether two reported paths name the same directory. The CLI sends a
 * path.resolve'd cwd (trailing slashes, `..`, `.` collapsed), so the only
 * remaining divergence to bridge is the Windows/MSYS dialect split (see
 * canonicalizeCwdForMatch). Symlinks and true case differences are still
 * treated as distinct, matching the exact-key intent. A missing path on either
 * side never matches.
 */
export function cwdPathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalizeCwdForMatch(a) === canonicalizeCwdForMatch(b);
}

/**
 * The idempotency predicate for `dor ensure`: true when the pane is *currently
 * running* `command` in `cwdPath`. It matches only while the command is live
 * (`currentCommand` is set between commandStart and commandFinish) and only on
 * the exact command line the shell reported via integration — never the
 * summarized display label, and never a forked child. Panes with no reported
 * command line (no shell integration) never match.
 */
export function surfaceRunsCommand(
  state: TerminalPaneState,
  command: string,
  cwdPath: string,
): boolean {
  const run = state.currentCommand;
  if (!run || run.rawCommandLine === null) return false;
  if (run.rawCommandLine !== command) return false;
  return cwdPathsEqual(run.cwdAtStart?.path ?? state.cwd?.path, cwdPath);
}

export function deriveFallbackCommandTitle(state?: TerminalPaneState | null): string {
  return latestTerminalTitleCandidate(state)?.title.trim() || DEFAULT_COMMAND_TITLE;
}

export function resolveDisplayPrimary(
  derivedPrimary: string,
  fallbackTitle: string | null | undefined,
): string {
  if (derivedPrimary === DEFAULT_IDLE_TITLE) return derivedPrimary;
  if (derivedPrimary !== DEFAULT_COMMAND_TITLE) return derivedPrimary;
  const trimmed = fallbackTitle?.trim();
  if (trimmed && trimmed !== UNNAMED_PANEL_TITLE) return trimmed;
  return derivedPrimary;
}

export function deriveHeader(
  pane: TerminalPaneState,
  visiblePanes: TerminalPaneState[],
  options: HeaderOptions = {},
): DerivedHeader {
  const primary = headerPrimary(pane, options);
  const samePrimary = visiblePanes.filter((candidate) => headerPrimary(candidate, options).text === primary.text);
  const cwd = effectiveCwd(pane);
  let secondary: string | undefined;

  if (samePrimary.length > 1) {
    const candidateCwds = samePrimary.map(effectiveCwd).filter((value): value is CwdState => !!value);
    if (cwd) {
      secondary = shortestUniqueCwdLabels(candidateCwds, options).get(cwdIdentity(cwd)) ?? cwdDisplay(cwd, options);
    } else {
      secondary = DEFAULT_DIRECTORY_LABEL;
    }
  }

  return { primary: primary.text, secondary, lastCommandFailed: primary.failed || undefined };
}

/** A single surface's display label: the derived header primary, with the
 *  saved/fallback title substituted when the primary is the generic command
 *  title. The one place to compose `deriveHeader` + `resolveDisplayPrimary` for
 *  one pane. **Takes no sibling set**: only `deriveHeader`'s `secondary`
 *  disambiguates against siblings, and this drops it — callers that need
 *  `secondary`/`lastCommandFailed` use `deriveHeader` directly. */
export function deriveSurfaceLabel(
  pane: TerminalPaneState,
  appTitleForPane: HeaderOptions['appTitleForPane'],
  fallbackTitle: string | null | undefined,
): string {
  return resolveDisplayPrimary(deriveHeader(pane, [], { appTitleForPane }).primary, fallbackTitle);
}

export function notificationDisplayTitle(
  notification: TerminalNotificationTitleLike | null | undefined,
): string | null {
  if (notification?.source === 'OSC 9') {
    const body = notification.body?.trim();
    if (body) return body;
  }
  return null;
}

export function terminalTitleFromNotification(
  notification: TerminalNotificationTitleLike | null | undefined,
  updatedAt = Date.now(),
): TerminalTitle | null {
  if (!notification) return null;
  if (notification.source === 'OSC 9') {
    const title = notificationDisplayTitle(notification);
    return title ? { title, source: 'osc9', updatedAt } : null;
  }
  if (notification.source === 'OSC 99') {
    const title = notification.title?.trim();
    return title ? { title, source: 'osc99', updatedAt } : null;
  }
  if (notification.source === 'OSC 777') {
    const title = notification.title?.trim();
    return title ? { title, source: 'osc777', updatedAt } : null;
  }
  return null;
}

export function buildAppTitleResolver(
  terminalStates: Map<string, TerminalPaneState>,
  activityStates: Map<string, { notification?: TerminalNotificationTitleLike | null }>,
): (pane: TerminalPaneState) => string | null {
  const titlesByPane = new WeakMap<TerminalPaneState, string>();
  for (const [id, pane] of terminalStates) {
    const title = notificationDisplayTitle(activityStates.get(id)?.notification);
    if (title) titlesByPane.set(pane, title);
  }
  return (pane) => titlesByPane.get(pane) ?? null;
}

/** Explanation uses the same winning-title functions as headerPrimary. */
export function explainTerminalTitle(pane: TerminalPaneState, options: HeaderOptions = {}): { source: string; value: string; note: string }[] {
  const user = titleCandidateForSource(pane, 'user')?.title.trim();
  const command = pane.currentCommand ?? pane.lastCommand;
  const app = options.appTitleForPane?.(pane)?.trim();
  const appWins = !user && !!command && !!app && isAppTitleFreshFor(pane, command);
  const terminal = !user && !appWins && command ? terminalTitleForCommand(pane, command) : null;
  const winner = terminal && command ? (command.finishedAt !== undefined && command.finalTerminalTitle && meaningfulTerminalTitle(command.finalTerminalTitle.title) ? command.finalTerminalTitle : findInRunTerminalTitle(pane, command)) : null;
  const candidates = titleCandidatesForDisplay(pane);
  const rows = candidates.map(candidate => ({
    source: titleSourceLabel(candidate.source), value: candidate.title,
    note: candidate.source === 'user' && user ? 'Used' : winner && candidate.source === winner.source && candidate.updatedAt === winner.updatedAt ? 'Used by command title' : 'Not used',
  }));
  if (winner && !candidates.some(candidate => candidate.source === winner.source && candidate.updatedAt === winner.updatedAt)) {
    rows.push({ source: `${titleSourceLabel(winner.source)} (command)`, value: winner.title, note: 'Used by command title' });
  }
  if (appWins) rows.push({ source: 'Notification', value: app!, note: 'Used' });
  if (command) rows.push({ source: 'Command', value: command.displayCommand, note: !user && !appWins && !terminal ? 'Used' : 'Fallback' });
  rows.push({ source: 'Result', value: headerPrimary(pane, options).text, note: pane.currentCommand ? 'Running' : 'Idle' });
  return rows;
}

export function titleCandidatesForDisplay(pane: TerminalPaneState): TerminalTitle[] {
  return Object.values(pane.titleCandidates)
    .filter((candidate): candidate is TerminalTitle => !!candidate)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.source.localeCompare(b.source));
}

export function titleSourceLabel(source: TerminalTitleSource): string {
  switch (source) {
    case 'osc0':
      return 'OSC 0';
    case 'osc2':
      return 'OSC 2';
    case 'osc9':
      return 'OSC 9';
    case 'osc99':
      return 'OSC 99';
    case 'osc777':
      return 'OSC 777';
    case 'user':
      return 'user';
  }
}

export function groupTerminalPanes(
  panes: TerminalPaneState[],
  mode: TerminalGroupingMode,
  options: DirectoryDisplayOptions = {},
): TerminalGroup[] {
  if (mode === 'none') {
    return [{ key: 'all', label: 'All', panes }];
  }

  if (mode === 'directory') {
    const cwds = panes.map(effectiveCwd).filter((cwd): cwd is CwdState => !!cwd);
    const labels = shortestUniqueCwdLabels(cwds, options);
    return groupBy(panes, (pane) => {
      const cwd = effectiveCwd(pane);
      if (!cwd) return { key: 'unknown', label: DEFAULT_DIRECTORY_LABEL };
      const key = cwdIdentity(cwd);
      return { key, label: labels.get(key) ?? cwdDisplay(cwd, options) };
    });
  }

  if (mode === 'command') {
    return groupBy(panes, (pane) => {
      const label = pane.currentCommand?.displayCommand ?? idleLabel(pane);
      return { key: label, label };
    });
  }

  return groupBy(panes, (pane) => {
    const status = statusBucket(pane.activity.kind);
    return { key: status, label: status };
  });
}

function statusBucket(kind: ShellActivity['kind']): 'unknown' | 'idle' | 'running' | 'finished' {
  switch (kind) {
    case 'running':
      return 'running';
    case 'finished':
      return 'finished';
    case 'unknown':
      return 'unknown';
    default:
      return 'idle';
  }
}

function cwdFromDecodedPath(rawPath: string, source: CwdSource, now: number): CwdState | null {
  const path = boundedCwdValue(rawPath);
  if (!path) return null;
  return {
    path,
    pathKind: inferPathKind(path),
    isRemote: isUncPath(path),
    source,
    updatedAt: now,
  };
}

function createCommandRunId(): string {
  nextCommandRunId += 1;
  return `cmd-${Date.now().toString(36)}-${nextCommandRunId.toString(36)}`;
}

function finishedActivity(exitCode: number | undefined): ShellActivity {
  return exitCode === undefined ? { kind: 'finished' } : { kind: 'finished', exitCode };
}

function normalizeFileUriPath(pathname: string): string {
  if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
  return pathname;
}

/**
 * The OSC 7 host, taken from the URL parser except where the raw slice is the
 * only place a distinction the header and `cwdIdentity` need survives.
 *
 * `parsed.hostname` is the mapped host: lowercased, IDNA-mapped (ignorable code
 * points removed, non-ASCII punycoded), and — for the file scheme alone —
 * `localhost` flattened to the empty string. Two of those erase something
 * worth keeping, so the raw slice wins for them and only them:
 *
 * - case, which is why the slice exists at all (`Prod-Box`, not `prod-box`);
 * - the literal `localhost` spelling, which the parser drops.
 *
 * Every other divergence is the parser normalizing input the slice reproduces
 * verbatim, and the mapped answer is the truthful one: `file://loc<ZWSP>alhost`
 * is localhost, so taking the slice would render a zero-width `localhost` that
 * reads as remote and splits its pane from the real one in the same directory.
 */
function fileUriHost(uri: string, parsedHostname: string): string {
  const sliced = extractFileUriHost(uri);
  if (!sliced) return parsedHostname;
  if (sliced.toLowerCase() === parsedHostname) return sliced;
  if (!parsedHostname && sliced.toLowerCase() === 'localhost') return sliced;
  return parsedHostname;
}

function extractFileUriHost(uri: string): string | undefined {
  // Anchored at the delimiters `new URL` honours: an unanchored `[^/]*` swallows
  // a `?`/`#` tail into the host, which then reads as remote and skews grouping.
  const match = uri.match(/^file:\/\/([^/?#]*)(?:[/?#]|$)/i);
  if (!match || !match[1]) return undefined;
  return safeDecodeURIComponent(match[1]);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The longest CWD any source may report. PATH_MAX is 4096 on Linux and 1024 on
 * macOS; a directory nobody can `cd` into is not one worth retaining.
 */
export const MAX_CWD_LENGTH = 4096;

/**
 * Strip control characters and cap the length of a reported CWD.
 *
 * A CWD is retained per Session, rendered in the pane header, and used as a
 * grouping key, so it is held state rather than a transient — the same reason
 * titles and notification bodies are sanitized (`terminal-protocol.ts`). The
 * emit-side scripts already remove control characters
 * (`docs/specs/terminal-escapes.md` → the `Cwd=` rule), but the parser accepts
 * OSC 7 / OSC 9;9 / OSC 1337 from any program, not only from those scripts.
 *
 * Interior whitespace is preserved rather than collapsed: a path may legally
 * contain runs of spaces, and this value is compared against real filesystem
 * paths.
 */
function boundedCwdValue(value: string): string {
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, '');
  return stripped.length <= MAX_CWD_LENGTH
    ? stripped
    : Array.from(stripped).slice(0, MAX_CWD_LENGTH).join('');
}

function inferPathKind(path: string): PathKind {
  if (isWindowsPath(path)) return 'windows';
  if (path.startsWith('/') || path.startsWith('~/')) return 'posix';
  return 'unknown';
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(path) || isUncPath(path);
}

function isUncPath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//');
}

function isRemoteFileHost(host: string | undefined): boolean {
  return !!host && host.toLowerCase() !== 'localhost';
}

function formatFullPath(path: string, homePath?: string): string {
  if (!homePath) return path;
  // Windows homes compare case-insensitively with either separator; a sibling
  // such as `/home/username` never abbreviates under `/home/user`.
  const windows = isWindowsPath(homePath);
  const normalize = (value: string) => (windows ? value.replace(/\\/g, '/').toLowerCase() : value);
  const home = normalize(homePath).replace(/\/$/, '');
  const candidate = normalize(path);
  return candidate === home || candidate.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function formatTrailingPath(path: string, kind: PathKind, depth: number): string {
  const parts = pathParts(path, kind);
  if (parts.segments.length === 0) return parts.root || path || DEFAULT_DIRECTORY_LABEL;
  const tail = parts.segments.slice(-Math.max(1, depth)).join(parts.separator);
  if (kind === 'windows' && parts.root && depth >= parts.segments.length) {
    return `${parts.root}${tail}`;
  }
  return tail;
}

function pathParts(path: string, kind: PathKind): { root: string; segments: string[]; separator: string } {
  if (kind === 'windows') {
    const normalized = path.replace(/\//g, '\\');
    const unc = normalized.match(/^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/);
    if (unc) {
      const rest = unc[3] ? unc[3].split('\\').filter(Boolean) : [];
      return { root: `\\\\${unc[1]}\\${unc[2]}\\`, segments: rest, separator: '\\' };
    }
    const drive = normalized.match(/^([A-Za-z]:)\\?(.*)$/);
    if (drive) {
      return { root: `${drive[1]}\\`, segments: drive[2].split('\\').filter(Boolean), separator: '\\' };
    }
    return { root: '', segments: normalized.split('\\').filter(Boolean), separator: '\\' };
  }

  return {
    root: path.startsWith('/') ? '/' : '',
    segments: path.split('/').filter(Boolean),
    separator: '/',
  };
}

function uniqueByIdentity(cwds: CwdState[]): CwdState[] {
  const result = new Map<string, CwdState>();
  for (const cwd of cwds) {
    const id = cwdIdentity(cwd);
    if (!result.has(id)) result.set(id, cwd);
  }
  return [...result.values()];
}

function findLabelCollisions(cwds: CwdState[], labels: Map<string, string>): Set<string> {
  const counts = new Map<string, number>();
  for (const cwd of cwds) {
    const label = labels.get(cwdIdentity(cwd));
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label));
}

function withRequiredHostPrefixes(
  cwds: CwdState[],
  baseLabels: Map<string, string>,
  options: DirectoryDisplayOptions,
): Map<string, string> {
  const result = new Map(baseLabels);
  const hostMode = options.includeHost ?? 'auto';
  const groups = new Map<string, CwdState[]>();
  for (const cwd of cwds) {
    const label = baseLabels.get(cwdIdentity(cwd));
    if (!label) continue;
    const group = groups.get(label) ?? [];
    group.push(cwd);
    groups.set(label, group);
  }

  for (const [label, group] of groups) {
    const hasCollision = group.length > 1;
    const samePathDifferentHosts = new Set(group.map((cwd) => cwd.path)).size < group.length &&
      new Set(group.map((cwd) => cwd.host ?? '')).size > 1;
    for (const cwd of group) {
      const shouldIncludeHost =
        hostMode === 'always' ||
        (hostMode === 'auto' && !!cwd.host && (cwd.isRemote || (hasCollision && samePathDifferentHosts)));
      if (shouldIncludeHost && cwd.host) {
        result.set(cwdIdentity(cwd), `${cwd.host}:${label}`);
      }
    }
  }

  return result;
}

/**
 * Split a command line into words, honoring quotes, POSIX backslash escapes,
 * and the pipeline/compound separators `| || && ; &` (and a case item's
 * `;; ;& ;;&`), which are emitted as their own tokens; `|&`, and fish's `&|`,
 * pipe both streams and are emitted as `|`. A redirection's `&` or `|` stays
 * in its word — `2>&1`, `<&3`, `>|`, and `&>` / `&>>`, which start a word of
 * their own — so none of them reads as a separator. An unquoted `#` starting a
 * word comments out the rest of its line. An unquoted newline
 * separates commands like `;`, and a backslash-newline continues the line. A
 * here-document's body — the lines after an unquoted `<<` / `<<-`'s own line,
 * through the one equal to its delimiter word with quotes removed — is
 * skipped, never read as commands. An unquoted `(` or `)` is a token of its
 * own too, except that a `$(…)` / `<(…)` / `>(…)` substitution or a `name=(…)`
 * array stays inside its word, whitespace and separators included; `{` and `}`
 * are grouping only as whole words, which the split already makes them.
 *
 * A `\` escapes exactly the `POSIX_ESCAPABLE` set (`foo\ bar` is one token,
 * `\*.ts` passes a literal glob, and a path Dormouse escaped for paste reads
 * back as itself); before anything else it is a literal, so a native Windows
 * program path survives tokenizing intact and `commandProgramName` still has
 * separators to split on. Two accepted costs of one dialect-free set: a Windows
 * segment that starts with a metacharacter (`C:\$Recycle.Bin`) still loses its
 * separator, and a POSIX escape of an ordinary character (`grep \-v`) keeps a
 * backslash bash would drop. Outside argv[0] both costs are display-only. Inside
 * it, the retained POSIX backslash becomes a basename separator (`foo\-bar` ->
 * `-bar`), while an eaten Windows separator leaves `C:\tools\$claude.exe`
 * keyed as `tools$claude.exe`.
 */
function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  // Open parentheses of the substitution or array being read.
  let wordParens = 0;
  // The last character when it was an unquoted, unescaped `$`, `<` or `>`: a
  // `(` right after it opens a substitution, and an `&` right after a `<` or
  // `>` (or a `|` after a `>`) belongs to that redirection.
  let operatorPrefix: string | null = null;
  // Here-documents opened on the current line, whose bodies follow it in order.
  const hereDocuments: HereDocument[] = [];

  const push = () => {
    if (!current) return;
    tokens.push(current);
    current = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const prefix = operatorPrefix;
    operatorPrefix = null;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      const next = input[i + 1];
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next !== undefined && POSIX_ESCAPABLE.test(next)) {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A substitution or array is one word, through the `)` closing its first `(`.
    if (wordParens > 0 || (char === '(' && (prefix !== null || ARRAY_ASSIGNMENT_PREFIX.test(current)))) {
      if (char === '(') wordParens += 1;
      else if (char === ')') wordParens -= 1;
      current += char;
      continue;
    }
    if (char === '\n') {
      push();
      tokens.push(';');
      // The lines after it are the bodies of the here-documents it opened.
      if (hereDocuments.length > 0) i = skipHereDocumentBodies(input, i + 1, hereDocuments.splice(0)) - 1;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === '(' || char === ')') {
      push();
      tokens.push(char);
      continue;
    }
    // `2>&1`, `<&3`, `>&-`, `>|`: the redirection it continues.
    if ((char === '&' && (prefix === '<' || prefix === '>')) || (char === '|' && prefix === '>')) {
      current += char;
      continue;
    }
    // `&>` / `&>>` redirect both streams, a word of their own.
    if (char === '&' && input[i + 1] === '>') {
      push();
      current = char;
      continue;
    }
    if ((char === '|' && input[i + 1] === '&') || (char === '&' && input[i + 1] === '|')) {
      push();
      tokens.push('|');
      i += 1;
      continue;
    }
    if (char === '&' && input[i + 1] === '&') {
      push();
      tokens.push('&&');
      i += 1;
      continue;
    }
    if (char === '|' && input[i + 1] === '|') {
      push();
      tokens.push('||');
      i += 1;
      continue;
    }
    // A case item's end: `;;`, `;&`, `;;&`.
    if (char === ';' && (input[i + 1] === ';' || input[i + 1] === '&')) {
      push();
      const end = input.startsWith(';;&', i) ? ';;&' : input.slice(i, i + 2);
      tokens.push(end);
      i += end.length - 1;
      continue;
    }
    if (char === '|' || char === ';' || char === '&') {
      push();
      tokens.push(char);
      continue;
    }
    // A `#` starting a word comments out the rest of its line.
    if (char === '#' && current === '' && (i === 0 || /[\s;&|()]/.test(input[i - 1]!))) {
      const newline = input.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }
    // `<<` or `<<-`, never the here-string `<<<`.
    if (char === '<' && input[i + 1] === '<' && input[i + 2] !== '<' && input[i - 1] !== '<') {
      const hereDocument = readHereDocumentDelimiter(input, i + 2);
      if (hereDocument) hereDocuments.push(hereDocument);
    }
    current += char;
    if (char === '$' || char === '<' || char === '>') operatorPrefix = char;
  }

  push();
  return tokens;
}

interface HereDocument {
  /** The delimiter word, quotes removed: its body ends at a line equal to it. */
  delimiter: string;
  /** `<<-`: leading tabs are stripped from each body line, the delimiter's included. */
  stripTabs: boolean;
}

/** The here-document a `<<` whose word starts at `from` opens, or null when no word follows it. */
function readHereDocumentDelimiter(input: string, from: number): HereDocument | null {
  let i = from;
  const stripTabs = input[i] === '-';
  if (stripTabs) i += 1;
  while (input[i] === ' ' || input[i] === '\t') i += 1;
  let delimiter = '';
  let quote: '"' | "'" | null = null;
  for (; i < input.length; i += 1) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else delimiter += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '\\' && i + 1 < input.length) {
      i += 1;
      delimiter += input[i];
    } else if (/\s/.test(char) || ';&|()<>'.includes(char)) {
      break;
    } else {
      delimiter += char;
    }
  }
  return delimiter ? { delimiter, stripTabs } : null;
}

/** Where the bodies of `hereDocuments`, one after another from `from`, end:
 *  past each one's delimiter line, or at the end of input. */
function skipHereDocumentBodies(input: string, from: number, hereDocuments: readonly HereDocument[]): number {
  let at = from;
  for (const { delimiter, stripTabs } of hereDocuments) {
    while (at < input.length) {
      const newline = input.indexOf('\n', at);
      const lineEnd = newline === -1 ? input.length : newline;
      const line = input.slice(at, lineEnd);
      at = lineEnd + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
    }
  }
  return Math.min(at, input.length);
}

/** A word that opens a `name=(…)` / `name+=(…)` array assignment at its `(`. */
const ARRAY_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;

function takePrimaryCommandTokens(tokens: string[]): string[] {
  // PowerShell's call operator. `& "C:\Program Files\nodejs\npm.cmd" run dev`
  // is the only way that shell runs a quoted program path, and a leading `&` is
  // never a POSIX background suffix, so drop it rather than read it as a
  // boundary that leaves no command at all.
  const words = tokens[0] === '&' ? tokens.slice(1) : tokens;
  const firstBoundary = words.findIndex((token) => token === '|' || LIST_SEPARATORS.has(token));
  const command = (firstBoundary === -1 ? words : words.slice(0, firstBoundary))
    .filter((token) => !GROUPING_TOKENS.has(token));
  let index = 0;
  while (isEnvAssignment(command[index])) index += 1;
  if (command[index] === 'env') {
    index += 1;
    while (isEnvAssignment(command[index])) index += 1;
  }
  return command.slice(index);
}

function isEnvAssignment(token: string | undefined): boolean {
  return !!token && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** The operators that end a case item. */
const CASE_ITEM_ENDS = new Set([';;', ';&', ';;&']);
const LIST_SEPARATORS = new Set(['&&', '||', ';', '&', ...CASE_ITEM_ENDS]);
/** The subshell and group operators `tokenizeCommand` emits; lexical only, so a
 *  group's inner list is split like any other. */
const GROUPING_TOKENS = new Set(['(', ')', '{', '}']);
/** Words that close a compound command, fish's `end` among them. A segment one
 *  leads holds only that command's redirections or pipeline (`done < list`,
 *  `fi | tee log`). */
const CLOSING_WORDS = new Set(['done', 'fi', 'esac', 'end', '}', ')']);
/** Words that open a compound command or one of its clauses, negate, or — fish's
 *  `and` / `or` — chain: the rest of their segment is the command they run. */
const OPENING_WORDS = new Set(['if', 'elif', 'then', 'else', 'while', 'until', 'do', '!', '(', '{', 'begin', 'and', 'or', 'not']);
/** Loop headers: a name and a word list, never a command. */
const LOOP_HEADERS = new Set(['for', 'select']);

/**
 * The simple commands of a list, in order, with the shell's grammar around them
 * taken out: separators, grouping, a compound command's reserved words (POSIX
 * and fish), a loop header, and a case item's pattern; a pipeline stays in one
 * piece. Lexical, like the tokenizer, and a reserved word counts only where a
 * command starts, so `for f in *; do make; done`, `if x; then make; fi` and
 * fish's `while x; make; end` run `make`.
 */
function listCommands(tokens: readonly string[]): string[][] {
  const commands: string[][] = [];
  /** The next command starts with a case item's `pattern)`, or — after a line
   *  `case WORD` — maybe with the `in` POSIX lets it put there. */
  let caseNext: 'pattern' | 'in' | null = null;
  let segment: string[] = [];

  const end = (): void => {
    let words = segment;
    segment = [];
    if (words.length === 0) return;
    if (CLOSING_WORDS.has(words[0]!)) {
      if (words[0] === 'esac') caseNext = null;
      return;
    }
    for (;;) {
      if (words.length === 0) return;
      const first = words[0]!;
      if (caseNext === 'in') {
        // Without it, the line was fish's `case PATTERN…`: patterns alone.
        caseNext = first === 'in' ? 'pattern' : null;
        if (caseNext !== null) words = words.slice(1);
      } else if (OPENING_WORDS.has(first)) {
        words = words.slice(1);
      } else if (caseNext === 'pattern') {
        caseNext = null;
        const close = words.indexOf(')');
        if (close === -1) break;
        words = words.slice(close + 1);
      } else if (first === 'case') {
        // `case WORD in`, then the first item's pattern.
        const inAt = words.indexOf('in', 2);
        caseNext = inAt === -1 ? 'in' : 'pattern';
        words = inAt === -1 ? [] : words.slice(inAt + 1);
      } else if (LOOP_HEADERS.has(first)) {
        return;
      } else {
        break;
      }
    }
    commands.push(words.filter((token) => !GROUPING_TOKENS.has(token)));
  };

  for (const token of tokens) {
    if (!LIST_SEPARATORS.has(token)) {
      segment.push(token);
      continue;
    }
    end();
    if (CASE_ITEM_ENDS.has(token)) caseNext = 'pattern';
  }
  end();
  return commands.filter((words) => words.length > 0);
}

interface FlagSpec {
  /** Flags that take the next word as their value. */
  value?: readonly string[];
  /** `VAR=value` words it accepts among its flags (`sudo FOO=1 make`). */
  assignments?: boolean;
}

interface WrapperSpec extends FlagSpec {
  /** Flags that stand alone; single letters may cluster (`-di`). A `value` flag
   *  may also carry its value attached (`-uroot`, `--user=root`). */
  bool?: readonly string[];
  /** A stand-alone flag shape not worth listing (nice's `-5`). */
  boolPattern?: RegExp;
  /** Positional words before the command it runs (`timeout 5m make`). */
  operands?: number;
  /** The command is a package spec, whose `@version` is not part of the name. */
  packageSpec?: boolean;
}

const PNPM_DLX: WrapperSpec = { value: ['--package'], bool: ['-s', '--silent'], packageSpec: true };
const BUN_X: WrapperSpec = { value: ['-p', '--package'], bool: ['--bun', '-y'], packageSpec: true };

/**
 * Programs that run the command named after their own flags, keyed as one word
 * or as a launcher's two (`pnpm dlx`). Only the flags listed are understood: an
 * unknown one stops the skip and the wrapper keys as itself, rather than
 * guessing whether that flag swallowed the next word. `env -S` and
 * `command -v` are unknown on purpose — neither runs its next word.
 */
const TRANSPARENT_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map(Object.entries({
  env: { value: ['-u', '--unset', '-C', '--chdir'], bool: ['-', '-i', '--ignore-environment', '-0', '--null', '-v', '--debug'], assignments: true },
  sudo: {
    value: ['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'],
    bool: ['-E', '--preserve-env', '-H', '--set-home', '-n', '--non-interactive', '-S', '--stdin', '-b', '--background', '-k', '--reset-timestamp', '-P', '--preserve-groups', '-A', '--askpass', '-B', '--bell', '-i', '--login', '-s', '--shell'],
    assignments: true,
  },
  doas: { value: ['-u'], bool: ['-n'] },
  time: { value: ['-o', '--output', '-f', '--format'], bool: ['-p', '--portability', '-v', '--verbose', '-a', '--append', '-l'] },
  nice: { value: ['-n', '--adjustment'], boolPattern: /^-\d+$/ },
  nohup: {},
  caffeinate: { value: ['-t', '-w'], bool: ['-d', '-i', '-m', '-s', '-u'] },
  command: { bool: ['-p'] },
  builtin: {},
  exec: { value: ['-a'], bool: ['-c', '-l'] },
  stdbuf: { value: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  timeout: { value: ['-k', '--kill-after', '-s', '--signal'], bool: ['-v', '--verbose', '--foreground', '--preserve-status'], operands: 1 },
  npx: { value: ['-p', '--package'], bool: ['-y', '--yes', '--no', '-q', '--quiet'], packageSpec: true },
  pnpx: PNPM_DLX,
  bunx: BUN_X,
  uvx: { value: ['--from', '--with', '-p', '--python'], bool: ['-q', '--quiet', '-v', '--verbose', '--isolated', '--offline'], packageSpec: true },
  'pnpm dlx': PNPM_DLX,
  'yarn dlx': { value: ['-p', '--package'], bool: ['-q', '--quiet'], packageSpec: true },
  'npm exec': { value: ['-p', '--package', '-w', '--workspace'], bool: ['-y', '--yes', '--no', '-q', '--quiet', '-ws', '--workspaces'], packageSpec: true },
  'bun x': BUN_X,
} satisfies Record<string, WrapperSpec>));

interface RunnerSpec extends FlagSpec {
  /** Value flags whose value is optional and numeric (make's `-j` / `-j 8`). */
  numeric?: readonly string[];
  /** A verb both spellings of a script share, dropped (`npm run test` is `npm test`). */
  drop?: readonly string[];
  /** A leading `+toolchain` word (`cargo +nightly build`). */
  toolchain?: boolean;
}

/**
 * Runners whose script is part of the key, so `pnpm dev` and `pnpm test` are
 * two rules. `value` lists the flags before the script that take a word; any
 * other flag is skipped as standing alone.
 */
const SCRIPT_RUNNERS: ReadonlyMap<string, RunnerSpec> = new Map(Object.entries({
  npm: { value: ['-C', '--prefix', '-w', '--workspace'], drop: ['run', 'run-script'] },
  pnpm: { value: ['-C', '--dir', '-F', '--filter'], drop: ['run'] },
  yarn: { value: ['--cwd'], drop: ['run'] },
  bun: { value: ['--cwd', '-F', '--filter', '-c', '--config'], drop: ['run'] },
  cargo: { value: ['-C', '--color', '--config', '-Z'], toolchain: true },
  make: {
    value: ['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if'],
    numeric: ['-j', '--jobs', '-l', '--load-average'],
    assignments: true,
  },
  just: { value: ['-f', '--justfile', '-d', '--working-directory', '--shell', '--dotenv-path', '--dotenv-filename', '--color'], assignments: true },
} satisfies Record<string, RunnerSpec>));

/** How many words a wrapper flag occupies under `spec`: 0 when it is not one it knows. */
function flagWidth(words: readonly string[], index: number, spec: WrapperSpec): number {
  const word = words[index]!;
  if (spec.bool?.includes(word) || spec.boolPattern?.test(word)) return 1;
  if (spec.value?.includes(word)) return 2;
  const equals = word.indexOf('=');
  if (word.startsWith('--')) {
    const name = equals > 0 ? word.slice(0, equals) : null;
    return name !== null && [spec.value, spec.bool].some((list) => list?.includes(name)) ? 1 : 0;
  }
  if (word.length > 2) {
    if (spec.value?.includes(word.slice(0, 2))) return 1;
    if ([...word.slice(1)].every((letter) => spec.bool?.includes(`-${letter}`))) return 1;
  }
  return 0;
}

/**
 * Where the command a wrapper at `index` runs starts, and whether that command
 * is a package spec; null when `words` holds no wrapper there, or one whose
 * flags are not understood.
 */
function wrappedCommandIndex(words: readonly string[], index: number): { index: number; packageSpec: boolean } | null {
  const program = commandProgramName(words[index] ?? '');
  const launcher = TRANSPARENT_WRAPPERS.get(`${program} ${words[index + 1] ?? ''}`);
  const spec = launcher ?? TRANSPARENT_WRAPPERS.get(program);
  if (!spec) return null;
  let i = index + (launcher ? 2 : 1);
  while (i < words.length) {
    const word = words[i]!;
    if (word === '--') {
      i += 1;
      break;
    }
    if (spec.assignments && isEnvAssignment(word)) {
      i += 1;
      continue;
    }
    if (!word.startsWith('-')) break;
    const width = flagWidth(words, i, spec);
    if (width === 0) return null;
    i += width;
  }
  i += spec.operands ?? 0;
  return i < words.length ? { index: i, packageSpec: spec.packageSpec === true } : null;
}

/** A redirection word: its operator after an optional fd (`2>&1`, `>log`), or
 *  the operator alone, its target the next word. A `<(…)` / `>(…)`
 *  substitution is a word, not one. */
const REDIRECTION = /^\d*(?:&>>?|[<>]&|>\||<>|>>?|<<<|<<-?|<)(?!\()/;

/** `words` without their redirections, each with its target. */
function withoutRedirections(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const operator = REDIRECTION.exec(word)?.[0];
    if (operator === undefined) kept.push(word);
    else if (operator === word) i += 1;
  }
  return kept;
}

/** One simple command's watch key: redirections, wrappers and assignments skipped, runners keyed by script. */
function watchKeyOfCommand(command: readonly string[]): string | null {
  const words = withoutRedirections(command);
  let index = 0;
  let packageSpec = false;
  for (;;) {
    while (isEnvAssignment(words[index])) index += 1;
    const wrapped = wrappedCommandIndex(words, index);
    if (!wrapped) break;
    ({ index, packageSpec } = wrapped);
  }
  let program = commandProgramName(words[index] ?? '');
  // `claude@latest`, but not a scope's leading `@`.
  if (packageSpec) program = program.replace(/^(.+?)@[^@]*$/, '$1');
  // A name with a space in it would read back as `<runner> <script>`.
  if (program.includes(' ') || !isWatchKey(program)) return null;
  const runner = SCRIPT_RUNNERS.get(program);
  if (!runner) return program;
  const script = runnerScript(words, index + 1, runner);
  return script !== null && isWatchKey(`${program} ${script}`) ? `${program} ${script}` : program;
}

/** The first word after a runner's own flags (and its shared verb): its script or target. */
function runnerScript(words: readonly string[], from: number, spec: RunnerSpec): string | null {
  let i = from;
  if (spec.toolchain && words[i]?.startsWith('+')) i += 1;
  let dropped = false;
  while (i < words.length) {
    const word = words[i]!;
    if (word.startsWith('-') && word !== '-') {
      // Any flag it does not list as taking a word stands alone.
      const takesWord = spec.value?.includes(word) || (spec.numeric?.includes(word) && /^\d+(?:\.\d+)?$/.test(words[i + 1] ?? ''));
      i += takesWord ? 2 : 1;
    } else if (spec.assignments && isEnvAssignment(word)) {
      i += 1;
    } else if (!dropped && spec.drop?.includes(word)) {
      dropped = true;
      i += 1;
    } else {
      return word;
    }
  }
  return null;
}

/** A path reduced to its last segment, in either dialect. */
function commandBasename(command: string): string {
  return command.replace(/^.*[\\/]/, '');
}

/** PATHEXT's spellings of one program. */
const WINDOWS_EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com|ps1)$/i;

/**
 * argv[0] reduced to the one name a program answers to: no path, no launcher
 * suffix. The single answer to "which program is this", so the header, the
 * WATCHING rule row and the terminal context cannot disagree about it.
 *
 * `C:\tools\claude.exe`, `npm.cmd` and `build.ps1` are `claude`, `npm` and
 * `build`: `.exe` / `.cmd` is how one program spells itself when PATHEXT
 * resolves it, so keeping the suffix would leave `npm` and `npm.cmd` as two
 * WATCHING rules for one program. Accepted: `foo.bat` and `foo.exe` in one
 * directory cannot be watched separately.
 */
export function commandProgramName(command: string): string {
  return commandBasename(command).replace(WINDOWS_EXECUTABLE_SUFFIX, '');
}

function commandTitleTokens(tokens: string[]): string[] {
  const command = tokens[0];
  if (!command) return [];
  const program = commandProgramName(command);
  const rest = tokens.slice(1);

  if (program === 'npm' && rest[0] === 'run') return [program, ...rest.slice(0, 2)];
  if (program === 'pnpm' || program === 'yarn' || program === 'bun') return [program, ...rest.slice(0, 2)];
  if (program === 'docker' && rest[0] === 'compose') return [program, ...rest.slice(0, 2)];
  if (program === 'cargo' && rest[0] === 'watch') return [program, ...rest.slice(0, 3)];
  if (program === 'ssh') return [program, ...rest.slice(0, 1)];
  if (program === 'vim' || program === 'nvim' || program === 'vi' || program === 'pytest') return [program];
  return [program, ...rest.slice(0, 2)];
}

function truncateCommandTitle(title: string): string {
  if (title.length <= COMMAND_TITLE_LIMIT) return title;
  return `${Array.from(title).slice(0, COMMAND_TITLE_LIMIT - 3).join('').trimEnd()}...`;
}

function headerPrimary(pane: TerminalPaneState, options: HeaderOptions): { text: string; failed: boolean } {
  const userTitle = titleCandidateForSource(pane, 'user')?.title.trim();
  if (userTitle) return { text: userTitle, failed: false };
  if (pane.currentCommand) return { text: commandHeaderLabel(pane, pane.currentCommand, options), failed: false };
  if (pane.lastCommand) {
    const idle = `${DEFAULT_IDLE_TITLE} ${commandHeaderLabel(pane, pane.lastCommand, options)}`;
    const failed = lastCommandFailed(pane.lastCommand);
    return { text: failed ? `${idle} ${COMMAND_FAIL_GLYPH}` : idle, failed };
  }
  return { text: DEFAULT_IDLE_TITLE, failed: false };
}

// A finished command "failed" only when we have a real non-zero exit code. The
// keystroke fallback never sets exitCode, so it shows no glyph either way.
function lastCommandFailed(command: CommandRun): boolean {
  return typeof command.exitCode === 'number' && command.exitCode !== 0;
}

function commandHeaderLabel(pane: TerminalPaneState, command: CommandRun, options: HeaderOptions): string {
  const appTitle = options.appTitleForPane?.(pane)?.trim();
  if (appTitle && isAppTitleFreshFor(pane, command)) return appTitle;
  const terminalTitle = terminalTitleForCommand(pane, command);
  if (terminalTitle) return terminalTitle;
  return command.displayCommand;
}

// appTitleForPane is sourced from the alert manager's current OSC 9 notification.
// The protocol parser populates titleCandidates.osc9 from the same OSC 9 stream,
// so when both exist they share a timestamp. Use the candidate to apply the same
// staleness rule we apply in terminalTitleForCommand: an OSC 9 emitted before the
// command started (or — for finished commands — after it ended) must not override
// the command's own label. If no osc9 candidate exists (e.g. notification was
// injected without going through the parser), trust the appTitle to preserve
// legacy behaviour.
function isAppTitleFreshFor(pane: TerminalPaneState, command: CommandRun): boolean {
  const osc9 = pane.titleCandidates.osc9;
  if (!osc9) return true;
  if (osc9.updatedAt < command.startedAt) return false;
  if (command.finishedAt !== undefined && osc9.updatedAt > command.finishedAt) return false;
  return true;
}

function idleLabel(pane: TerminalPaneState): string {
  const userTitle = titleCandidateForSource(pane, 'user')?.title.trim();
  if (userTitle) return userTitle;
  return DEFAULT_IDLE_TITLE;
}

const HEADER_APP_TITLE_SOURCES: TerminalTitleSource[] = ['osc0', 'osc2', 'osc9'];

// Under Windows ConPTY an OSC 0/2 title is frequently just the child process's
// image path (e.g. `C:\WINDOWS\system32\cmd.exe`, which pnpm's script shell
// broadcasts) rather than a name the app meaningfully chose — ConPTY relays the
// console title for every process whether or not it set one. A bare executable
// path or shell name carries no command information, so we don't let it override
// the command we detected. Descriptive titles (anything carrying arguments or
// text, e.g. `lazygit: dormouse` or `README.md - VIM`) are kept.
const GENERIC_PROCESS_TITLE_NAMES = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'wsl', 'conhost',
]);

function isGenericProcessTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  // Basename, not program name: the suffix is the evidence this test is looking
  // for, so stripping it would leave every `.exe` title indistinguishable.
  const basename = commandBasename(trimmed);
  if (/\s/.test(basename)) return false; // carries arguments/description → meaningful
  if (WINDOWS_EXECUTABLE_SUFFIX.test(basename)) return true; // bare executable path
  return GENERIC_PROCESS_TITLE_NAMES.has(basename.toLowerCase()); // bare shell/interpreter name
}

// Reduce a raw OSC title to its meaningful part, or null when there's nothing
// useful. Drops bare interpreter paths/names, and strips cmd.exe's
// `<path>\cmd.exe - <command>` prefix (cmd announces its own path alongside the
// command it's running) so the command shows rather than the interpreter path.
function meaningfulTerminalTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed || isGenericProcessTitle(trimmed)) return null;
  const separator = trimmed.indexOf(' - ');
  if (separator > 0 && isGenericProcessTitle(trimmed.slice(0, separator))) {
    const rest = trimmed.slice(separator + 3).trim();
    return rest.length > 0 ? rest : null;
  }
  return trimmed;
}

function terminalTitleForCommand(pane: TerminalPaneState, command: CommandRun): string | null {
  // For finished commands the live `titleCandidates` map may have been overwritten by post-finish
  // events (e.g. the shell resetting OSC 0 to `zsh`), so trust the snapshot taken at commandFinish.
  if (command.finishedAt !== undefined && command.finalTerminalTitle) {
    const snapshot = meaningfulTerminalTitle(command.finalTerminalTitle.title);
    if (snapshot) return snapshot;
  }
  const inRun = findInRunTerminalTitle(pane, command)?.title;
  return inRun ? meaningfulTerminalTitle(inRun) : null;
}

function snapshotInRunTerminalTitle(
  state: TerminalPaneState,
  command: CommandRun,
  finishedAt: number,
): TerminalTitle | undefined {
  // Same scan as findInRunTerminalTitle but with an explicit upper bound, used by the reducer
  // before `command.finishedAt` is set.
  let best: TerminalTitle | undefined;
  for (const source of HEADER_APP_TITLE_SOURCES) {
    const candidate = state.titleCandidates[source];
    if (!candidate) continue;
    if (candidate.updatedAt < command.startedAt) continue;
    if (candidate.updatedAt > finishedAt) continue;
    if (!best || candidate.updatedAt > best.updatedAt) best = candidate;
  }
  return best;
}

function findInRunTerminalTitle(pane: TerminalPaneState, command: CommandRun): TerminalTitle | null {
  let best: TerminalTitle | null = null;
  for (const source of HEADER_APP_TITLE_SOURCES) {
    const candidate = pane.titleCandidates[source];
    if (!candidate) continue;
    if (candidate.updatedAt < command.startedAt) continue;
    if (command.finishedAt !== undefined && candidate.updatedAt > command.finishedAt) continue;
    if (!best || candidate.updatedAt > best.updatedAt) best = candidate;
  }
  return best;
}

/** The directory a pane is "in": the running command's `cwdAtStart`, else the
 *  shell's cwd (`docs/specs/terminal-state.md`). */
export function effectiveCwd(pane: TerminalPaneState): CwdState | null {
  return pane.currentCommand?.cwdAtStart ?? pane.cwd;
}

function groupBy(
  panes: TerminalPaneState[],
  keyForPane: (pane: TerminalPaneState) => { key: string; label: string },
): TerminalGroup[] {
  const groups = new Map<string, TerminalGroup>();
  for (const pane of panes) {
    const { key, label } = keyForPane(pane);
    const existing = groups.get(key);
    if (existing) {
      existing.panes.push(pane);
    } else {
      groups.set(key, { key, label, panes: [pane] });
    }
  }
  return [...groups.values()];
}

function latestTerminalTitleCandidate(state: TerminalPaneState | null | undefined): TerminalTitle | null {
  if (!state) return null;
  let latest: TerminalTitle | null = null;
  for (const candidate of Object.values(state.titleCandidates)) {
    if (!candidate || !HEADER_APP_TITLE_SOURCES.includes(candidate.source)) continue;
    if (!latest || candidate.updatedAt > latest.updatedAt) latest = candidate;
  }
  return latest;
}

function titleCandidateForSource(
  pane: TerminalPaneState,
  source: TerminalTitleSource,
): TerminalTitle | null {
  return pane.titleCandidates[source] ?? null;
}

