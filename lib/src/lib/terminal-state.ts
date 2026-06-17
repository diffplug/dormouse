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
  title: TerminalTitle | null;
  titleCandidates: TerminalTitleCandidates;
}

export type TerminalSemanticEvent =
  | { type: 'cwd'; cwd: CwdState }
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'commandLine'; commandLine: string }
  | { type: 'commandStart'; source?: CommandRunSource; startedAt?: number }
  | { type: 'commandFinish'; exitCode?: number }
  | { type: 'title'; title: TerminalTitle };

export interface DirectoryDisplayOptions {
  includeHost?: 'auto' | 'always' | 'never';
  style?: 'basename' | 'short' | 'full';
  maxSegments?: number;
  homePath?: string;
}

export interface HeaderOptions extends DirectoryDisplayOptions {
  shellName?: string;
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
  const titleCandidates: TerminalTitleCandidates = { ...initial?.titleCandidates };
  if (initial?.title) titleCandidates[initial.title.source] = initial.title;
  let title = initial?.title ?? null;
  if (!title) {
    for (const candidate of Object.values(titleCandidates)) {
      if (candidate && (!title || candidate.updatedAt > title.updatedAt)) title = candidate;
    }
  }
  return {
    cwd: initial?.cwd ?? null,
    activity: initial?.activity ?? { kind: 'unknown' },
    pendingCommandLine: initial?.pendingCommandLine ?? null,
    currentCommand: initial?.currentCommand ?? null,
    lastCommand: initial?.lastCommand ?? null,
    title,
    titleCandidates,
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
      const raw = state.pendingCommandLine;
      const source = event.source === 'osc633_boundaries' && raw
        ? 'osc633_E'
        : event.source ?? (raw ? 'osc633_E' : 'osc133_boundaries');
      return {
        ...state,
        currentCommand: {
          id: createId(),
          rawCommandLine: raw,
          displayCommand: raw ? summarizeCommandLine(raw) : deriveFallbackCommandTitle(state),
          cwdAtStart: state.cwd,
          startedAt: event.startedAt ?? now(),
          source,
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
      const finishedAt = now();
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
      if (state.title && existing && sameTitle(state.title, event.title) && sameTitle(existing, event.title)) {
        return state;
      }
      return {
        ...state,
        title: event.title,
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

export function cwdFromOsc7(rawUri: string, now = Date.now()): CwdState | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;

  const decodedPath = normalizeFileUriPath(safeDecodeURIComponent(parsed.pathname));
  const host = extractFileUriHost(rawUri) || parsed.hostname || undefined;
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
  const path = safeDecodeURIComponent(rawPath.trim());
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
  const hasCompound = tokens.some((token) => token === '&&' || token === '||' || token === ';');
  const visibleTokens = commandTitleTokens(commandTokens);
  const suffix = hasPipeline ? ' | ...' : hasCompound ? ' ...' : '';
  return truncateCommandTitle(`${visibleTokens.join(' ')}${suffix}`);
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
  // Exact compare, matching the command half. The CLI sends a path.resolve'd cwd
  // (trailing slashes, `..`, `.` already collapsed), so there's nothing further
  // to normalize here — and trailing-slash trimming wouldn't address the real
  // divergences (symlinks, case) anyway.
  const runCwd = run.cwdAtStart?.path ?? state.cwd?.path;
  return runCwd === cwdPath;
}

export function deriveFallbackCommandTitle(
  state?: TerminalPaneState | null,
  options: { shellName?: string } = {},
): string {
  const title = latestTerminalTitleCandidate(state)?.title.trim();
  if (title) return title;
  return options.shellName?.trim() || DEFAULT_COMMAND_TITLE;
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
  const cwd = cwdForHeader(pane);
  let secondary: string | undefined;

  if (samePrimary.length > 1) {
    const candidateCwds = samePrimary.map(cwdForHeader).filter((value): value is CwdState => !!value);
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
 *  one pane; callers that also need `secondary`/`lastCommandFailed` use
 *  `deriveHeader` directly. */
export function deriveSurfaceLabel(
  pane: TerminalPaneState,
  visiblePanes: TerminalPaneState[],
  appTitleForPane: HeaderOptions['appTitleForPane'],
  fallbackTitle: string | null | undefined,
): string {
  return resolveDisplayPrimary(deriveHeader(pane, visiblePanes, { appTitleForPane }).primary, fallbackTitle);
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
    const cwds = panes.map(directoryGroupCwd).filter((cwd): cwd is CwdState => !!cwd);
    const labels = shortestUniqueCwdLabels(cwds, options);
    return groupBy(panes, (pane) => {
      const cwd = directoryGroupCwd(pane);
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
  const path = safeDecodeURIComponent(rawPath.trim());
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

function extractFileUriHost(uri: string): string | undefined {
  const match = uri.match(/^file:\/\/([^/]*)(?:\/|$)/i);
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
  if (homePath && (path === homePath || path.startsWith(`${homePath}/`))) {
    return `~${path.slice(homePath.length)}`;
  }
  return path;
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

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const push = () => {
    if (!current) return;
    tokens.push(current);
    current = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
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
    if (/\s/.test(char)) {
      push();
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
    if (char === '|' || char === ';' || char === '&') {
      push();
      tokens.push(char);
      continue;
    }
    current += char;
  }

  push();
  return tokens;
}

function takePrimaryCommandTokens(tokens: string[]): string[] {
  const firstBoundary = tokens.findIndex((token) => token === '|' || token === '&&' || token === '||' || token === ';' || token === '&');
  const command = (firstBoundary === -1 ? tokens : tokens.slice(0, firstBoundary)).filter(Boolean);
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

function commandTitleTokens(tokens: string[]): string[] {
  const command = tokens[0];
  if (!command) return [];
  const basename = command.split(/[\\/]/).pop() ?? command;
  const rest = tokens.slice(1);

  if (basename === 'npm' && rest[0] === 'run') return [basename, ...rest.slice(0, 2)];
  if (basename === 'pnpm' || basename === 'yarn' || basename === 'bun') return [basename, ...rest.slice(0, 2)];
  if (basename === 'docker' && rest[0] === 'compose') return [basename, ...rest.slice(0, 2)];
  if (basename === 'cargo' && rest[0] === 'watch') return [basename, ...rest.slice(0, 3)];
  if (basename === 'ssh') return [basename, ...rest.slice(0, 1)];
  if (basename === 'vim' || basename === 'nvim' || basename === 'vi' || basename === 'pytest') return [basename];
  return [basename, ...rest.slice(0, 2)];
}

function truncateCommandTitle(title: string): string {
  if (title.length <= COMMAND_TITLE_LIMIT) return title;
  return `${Array.from(title).slice(0, COMMAND_TITLE_LIMIT - 3).join('').trimEnd()}...`;
}

// Returns the title text plus whether it carries the fail glyph, so callers can
// color the glyph without inferring its presence by matching the string.
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
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  if (/\s/.test(basename)) return false; // carries arguments/description → meaningful
  if (/\.(?:exe|com|bat|cmd|ps1)$/i.test(basename)) return true; // bare executable path
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

function cwdForHeader(pane: TerminalPaneState): CwdState | null {
  if (pane.currentCommand?.cwdAtStart) return pane.currentCommand.cwdAtStart;
  return pane.cwd;
}

function directoryGroupCwd(pane: TerminalPaneState): CwdState | null {
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
    if (!candidate || candidate.source === 'user') continue;
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

