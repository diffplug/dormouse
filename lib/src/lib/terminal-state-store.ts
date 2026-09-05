import {
  commandArgv0,
  createTerminalPaneState,
  cwdFromManualPath,
  cwdFromProcessPath,
  DEFAULT_IDLE_TITLE,
  processCwdMayReplace,
  reduceTerminalState,
  type CwdState,
  type TerminalPaneState,
  type TerminalSemanticEvent,
  type TerminalTitle,
} from './terminal-state';
import {
  createPromptSubmitState,
  detectPromptSubmit,
  type PromptSubmitState,
} from './terminal-command-input';
import { derivePromptShape, extractCommand, type PromptShape } from './terminal-prompt-shape';
import { stripTerminalControls, TerminalControlStreamFilter } from './terminal-controls';
import { getSessionIdByPtyId } from './terminal-store';

const paneStates = new Map<string, TerminalPaneState>();
const promptSubmitStates = new Map<string, PromptSubmitState>();
const promptShapes = new Map<string, PromptShape>();
const promptOutputBuffers = new Map<string, string>();
// Panes with authentic OSC 633/133 boundaries; the keystroke fallback stands
// down for each id here until the pane is reset or removed.
const oscDrivenPanes = new Set<string>();
const listeners = new Set<() => void>();

// Authentic shell boundaries; heuristic-synthesized prompt markers are excluded.
function isOscDrivenBoundary(event: TerminalSemanticEvent): boolean {
  switch (event.type) {
    case 'promptStart':
    case 'promptEnd':
    case 'commandFinish':
      return true;
    case 'commandStart':
      return event.source === 'osc633_boundaries' || event.source === 'osc133_boundaries';
    default:
      return false;
  }
}
let cachedSnapshot: Map<string, TerminalPaneState> | null = null;

export function subscribeToTerminalPaneState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTerminalPaneStateSnapshot(): Map<string, TerminalPaneState> {
  if (cachedSnapshot) return cachedSnapshot;
  cachedSnapshot = new Map(paneStates);
  return cachedSnapshot;
}

export function getTerminalPaneState(id: string): TerminalPaneState {
  return paneStates.get(id) ?? createTerminalPaneState();
}

/**
 * The bare program name of the pane's foreground command, or null when the pane
 * is at a prompt (or its shell reported no command line). This is the key the
 * WATCHING rule set is stored under, so the bell and the alert dialog both use
 * it to decide which rule they are toggling — see `docs/specs/alert.md`.
 */
export function getRunningCommandArgv0(id: string): string | null {
  const raw = paneStates.get(id)?.currentCommand?.rawCommandLine;
  return raw ? commandArgv0(raw) : null;
}

// Count sessions whose latest activity is a live/running command (not an idle
// shell at a prompt). The standalone quit orchestrator uses this to decide
// whether a quit needs a confirmation (docs/specs/standalone.md §Quit flow).
export function countRunningSessions(): number {
  let count = 0;
  for (const state of paneStates.values()) {
    if (state.activity.kind === 'running') count++;
  }
  return count;
}

// Whether shell integration can re-report a programmatic `dor ensure` command,
// which is required for later matching/restart.
export function isPaneOscDriven(id: string): boolean {
  return oscDrivenPanes.has(id);
}

export function ensureTerminalPaneState(id: string, initial?: Partial<TerminalPaneState>): TerminalPaneState {
  const existing = paneStates.get(id);
  if (existing) return existing;
  const next = createTerminalPaneState(initial);
  paneStates.set(id, next);
  notifyTerminalPaneStateListeners();
  return next;
}

/** Drops every per-pane scratch map keyed by `id`; `paneStates` is the caller's
 * to set or delete. Add new per-pane state here, not at the two call sites. */
function clearPaneScratch(id: string): void {
  promptSubmitStates.delete(id);
  promptShapes.delete(id);
  promptOutputBuffers.delete(id);
  oscDrivenPanes.delete(id);
}

export function resetTerminalPaneState(id: string, initial?: Partial<TerminalPaneState>): void {
  clearPaneScratch(id);
  paneStates.set(id, createTerminalPaneState(initial));
  notifyTerminalPaneStateListeners();
}

export function removeTerminalPaneState(id: string): void {
  clearPaneScratch(id);
  if (!paneStates.delete(id)) return;
  notifyTerminalPaneStateListeners();
}

export function applyTerminalSemanticEventsByPtyId(ptyId: string, events: TerminalSemanticEvent[]): void {
  const id = resolvePaneStateIdByPtyId(ptyId);
  applyTerminalSemanticEvents(id, events);
}

export function applyTerminalSemanticEvents(
  id: string,
  events: TerminalSemanticEvent[],
  options?: { keystrokeHeuristic?: boolean },
): void {
  if (events.length === 0) return;
  // `keystrokeHeuristic` marks the fallback's own synthesized markers, which must
  // not promote the pane — that would retire the very path emitting them.
  if (!options?.keystrokeHeuristic && !oscDrivenPanes.has(id) && events.some(isOscDrivenBoundary)) {
    oscDrivenPanes.add(id);
  }
  if (events.some((event) => event.type === 'promptStart' || event.type === 'promptEnd' || event.type === 'commandStart')) {
    promptSubmitStates.delete(id);
    promptOutputBuffers.delete(id);
    // promptShapes intentionally survives — the prompt shape is stable across
    // commands and we want it ready for the next one.
  }
  const prev = paneStates.get(id) ?? createTerminalPaneState();
  let next = prev;
  for (const event of events) {
    next = reduceTerminalState(next, event);
  }
  if (next === prev && paneStates.has(id)) return;
  paneStates.set(id, next);
  notifyTerminalPaneStateListeners();
}

// Reads the cursor's full rendered logical line (`prompt + command`) from the
// terminal buffer at submit time. The store strips the prompt off the front
// using the learned prompt shape.
export interface PromptLineReader {
  readLine(): string | null;
}

export function recordTerminalUserInput(id: string, input: string, reader?: PromptLineReader): void {
  if (!input) return;
  // Shell integration is authoritative once it's emitting OSC boundaries; don't
  // also synthesize command starts from keystrokes (that would double-count).
  if (oscDrivenPanes.has(id)) return;
  const state = paneStates.get(id) ?? createTerminalPaneState();
  if (state.currentCommand || state.activity.kind === 'running' || state.activity.kind === 'finished') return;

  const submitState = promptSubmitStates.get(id) ?? createPromptSubmitState();
  const next = detectPromptSubmit(submitState, input);
  promptSubmitStates.set(id, next.state);

  if (!next.submitted) return;

  // Read the rendered `prompt + command` line and strip the prompt using the
  // shape we learned from a recent bare prompt. This sees history recall, paste,
  // and autosuggest because it reads what's actually on screen.
  const renderedLine = reader?.readLine() ?? null;
  const shape = promptShapes.get(id) ?? null;
  const commandLine = renderedLine && shape ? extractCommand(renderedLine, shape) : null;
  if (commandLine) {
    applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine },
      { type: 'commandStart', source: 'user_input' },
    ]);
  }
}

export function recordTerminalUserInputByPtyId(ptyId: string, input: string, reader?: PromptLineReader): void {
  recordTerminalUserInput(resolvePaneStateIdByPtyId(ptyId), input, reader);
}

// Programmatic launches bypass onData, so seed before the PTY write. For split /
// ensure this run is also the readiness sentinel: the first prompt clears it,
// then typing bridges the gap until authentic OSC re-reports the command.
// `user_input` avoids falsely promoting the pane to OSC-driven.
export function seedLaunchedCommand(id: string, command: string, cwdPath?: string): void {
  const events: TerminalSemanticEvent[] = [];
  const cwd = cwdPath ? cwdFromManualPath(cwdPath) : null;
  if (cwd) events.push({ type: 'cwd', cwd });
  events.push({ type: 'commandLine', commandLine: command });
  events.push({ type: 'commandStart', source: 'user_input' });
  applyTerminalSemanticEvents(id, events);
}

export function finishLaunchedCommandByPtyId(ptyId: string, exitCode: number): void {
  applyTerminalSemanticEventsByPtyId(ptyId, [{ type: 'commandFinish', exitCode }]);
}

/**
 * Records a chunk of a pane's output for the keystroke prompt heuristic.
 * **Takes `TerminalProtocolParseResult.textData`, not the raw chunk** — the
 * parser has already dropped string-control payloads, so a chunked inline image
 * can never reach the 1,024-character prompt window
 * (`docs/specs/terminal-state.md`).
 */
export function recordTerminalOutput(id: string, output: string): void {
  if (!output) return;

  const buffer = `${promptOutputBuffers.get(id) ?? ''}${output}`.slice(-1024);
  promptOutputBuffers.set(id, buffer);
  const promptLine = detectReturnedShellPrompt(buffer);
  if (!promptLine) return;
  promptOutputBuffers.delete(id);

  // Learn/refresh the prompt shape from every prompt we see — including the
  // shell's very first prompt at spawn — so command extraction works from the
  // first command, recall included.
  const shape = derivePromptShape(promptLine);
  if (shape) promptShapes.set(id, shape);

  // The idle transition only applies while a keystroke-submitted command is
  // running; OSC-tracked shells drive their own boundaries.
  const state = paneStates.get(id);
  if (state?.currentCommand?.source === 'user_input') {
    // Flagged as the heuristic's own synthesis so it doesn't mark the pane
    // OSC-driven (which would then silence the very path emitting this).
    applyTerminalSemanticEvents(id, [{ type: 'promptStart' }, { type: 'promptEnd' }], { keystrokeHeuristic: true });
  }
}

export function recordTerminalOutputByPtyId(ptyId: string, output: string): void {
  recordTerminalOutput(resolvePaneStateIdByPtyId(ptyId), output);
}

// Pre-seed the prompt shape from restored scrollback. On reconnect to a live
// pty the shell won't re-emit its prompt, so without this the first command
// after a restore has no shape to strip and goes untitled until the next
// prompt. The scrollback ends at whatever was on screen: if that's an idle
// prompt we learn the shape, otherwise we no-op and wait for the next live
// prompt. Learn-only — fires no idle transition.
export function seedPromptShapeFromScrollback(id: string, scrollback: string): void {
  if (!scrollback) return;
  // Replay arrives as `visibleData`, which still carries the string controls the
  // parser forwards, so this path filters for itself. It is one shot over a
  // bounded tail rather than the live stream: the prompt is in the last few
  // hundred characters, and 64 KiB is ample runway to resync the control state
  // before the 1024 the result is cut to.
  const text = new TerminalControlStreamFilter().process(scrollback.slice(-65_536));
  const promptLine = detectReturnedShellPrompt(text.slice(-1024));
  if (!promptLine) return;
  const shape = derivePromptShape(promptLine);
  if (shape) promptShapes.set(id, shape);
}

export type SetTerminalUserTitleResult =
  | { accepted: true }
  | { accepted: false; reason: 'empty' | 'reserved' };

// `<idle>` is the sentinel that prefixes the auto-generated header for finished panes
// (`<idle> ${LAST_TITLE}`); any user-pin title starting with `<idle>` would be indistinguishable
// from that derived state. `<unnamed>` is just the default panel placeholder, so we let users
// pin to it explicitly if they want — the resume/restore seed paths already skip `<unnamed>`
// before calling this function, so they never accidentally seed it as a real pin.
export function isReservedUserTitle(trimmed: string): boolean {
  return trimmed === DEFAULT_IDLE_TITLE || trimmed.startsWith(DEFAULT_IDLE_TITLE);
}

export function setTerminalUserTitle(id: string, title: string): SetTerminalUserTitleResult {
  const trimmed = title.trim();
  if (!trimmed) return { accepted: false, reason: 'empty' };
  if (isReservedUserTitle(trimmed)) return { accepted: false, reason: 'reserved' };
  const terminalTitle: TerminalTitle = {
    title: trimmed,
    source: 'user',
    updatedAt: Date.now(),
  };
  applyTerminalSemanticEvents(id, [{ type: 'title', title: terminalTitle }]);
  return { accepted: true };
}

export function seedTerminalManualCwd(id: string, path: string | null | undefined): void {
  const cwd = path ? cwdFromManualPath(path) : null;
  const current = paneStates.get(id);
  if (!cwd) {
    ensureTerminalPaneState(id);
    return;
  }
  if (!current) {
    ensureTerminalPaneState(id, { cwd });
    return;
  }
  if (current.cwd) return;
  paneStates.set(id, { ...current, cwd });
  notifyTerminalPaneStateListeners();
}

export function fillTerminalProcessCwd(id: string, path: string | null | undefined): void {
  if (!path) return;
  const cwd = cwdFromProcessPath(path);
  if (!cwd) return;
  updateCwdIfAllowed(id, cwd);
}

export function fillTerminalProcessCwdByPtyId(ptyId: string, path: string | null | undefined): void {
  fillTerminalProcessCwd(resolvePaneStateIdByPtyId(ptyId), path);
}

function updateCwdIfAllowed(id: string, cwd: CwdState): void {
  const current = paneStates.get(id);
  if (!current) return;
  if (!processCwdMayReplace(current.cwd?.source)) return;
  paneStates.set(id, { ...current, cwd });
  notifyTerminalPaneStateListeners();
}

function resolvePaneStateIdByPtyId(ptyId: string): string {
  return getSessionIdByPtyId(ptyId) ?? ptyId;
}

// Detect a returned/idle shell prompt for shells without OSC 133/633
// integration, returning the prompt line (for shape learning) or null. Custom
// prompts that lack the path/user context signal (`/`, `~`, `@`, `:`) or a
// recognized terminator (`$`, `#`, `%`, `>`) won't match — intentional, since
// false positives would prematurely flip a running command back to idle. The
// 1024-char tail this reads lands mid-sequence routinely, which is why the
// shared `stripTerminalControls` swallows an unterminated string control: a
// buffer ending in a half-arrived title OSC would otherwise offer its payload
// up as the last visible line.
function detectReturnedShellPrompt(output: string): string | null {
  const visible = stripAltScreenSpans(output);
  const normalizeBreaks = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Boundary mode, for the same reason `detectResumeCommand` uses it: deleting a
  // redraw's cursor move welds text that was never adjacent on screen, and this
  // reads the result as a *line*. Without it, `building...\x1b[1;1H➜  ~ ` reads
  // as the single line `building...➜  ~ `, and the prompt goes undetected.
  const text = normalizeBreaks(stripTerminalControls(visible, { boundaries: true }));
  // A boundary is not a real line break, though, and the difference decides the
  // safe direction. A genuine trailing newline means nothing has been painted on
  // the current line yet — no prompt — and that must keep returning null, because
  // a false positive here flips a running command back to idle. A *boundary* at
  // the tail means only that a control sequence closed the line: a prompt that
  // clears to end-of-line after painting itself (`➜  ~ \x1b[K`) is the common
  // case, and treating that as an empty last line would hide every such prompt.
  // Stripping without boundaries leaves exactly the real breaks, so it answers
  // which one this is.
  const endsOnRealNewline = /\n$/.test(normalizeBreaks(stripTerminalControls(visible)));
  let searchEnd = text.length;
  if (!endsOnRealNewline) {
    while (searchEnd > 0 && text[searchEnd - 1] === '\n') searchEnd--;
  }
  const head = text.slice(0, searchEnd);
  // Prompts usually come on a fresh line; that rejects arbitrary command output
  // that happens to end with a prompt-like character. The spawn-time first
  // prompt may be the whole buffer with no leading newline, so accept that too.
  const newlineIndex = head.lastIndexOf('\n');
  const lastLine = (newlineIndex === -1 ? head : head.slice(newlineIndex + 1)).trimStart();
  if (lastLine.length > 200) return null;
  // PowerShell `PS C:\path>` (with optional trailing space).
  if (/^PS\s+\S.*>\s?$/.test(lastLine)) return lastLine;
  // cmd.exe `C:\path>` — a drive-letter path ending in `>`, and (unlike every
  // other shell here) with no trailing space.
  if (/^[A-Za-z]:\\.*>\s?$/.test(lastLine)) return lastLine;
  // Arrow-style prompts (oh-my-zsh, starship, fish defaults).
  if (/^[➜❯λ]\s+\S/.test(lastLine) && lastLine.endsWith(' ')) return lastLine;
  // Multi-line prompts whose final line is just the terminator (e.g. Git Bash's
  // `$ ` beneath a `user@host MINGW64 /path` line). Accept only when the
  // preceding non-blank line carries prompt context, so stray output ending in
  // `$ ` doesn't match.
  if (/^[$#%]\s*$/.test(lastLine)) {
    return precedingLineHasPromptContext(head, newlineIndex) ? lastLine : null;
  }
  // Generic single-line prompts: require a path/user context signal AND a
  // trailing prompt char + space. The context check rejects lines like
  // "step 1: done" or "loading 95% complete".
  if (lastLine.length < 3) return null;
  if (!/[\/~@:]/.test(lastLine)) return null;
  return /[$#%>]\s$/.test(lastLine) ? lastLine : null;
}

// Whether the non-blank line preceding `lastNewlineIndex` looks like prompt
// context (carries a `/`, `~`, `@`, or `:`). Used to validate a bare-terminator
// final line in a multi-line prompt.
function precedingLineHasPromptContext(text: string, lastNewlineIndex: number): boolean {
  let end = lastNewlineIndex;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1);
    const line = text.slice(start + 1, end).trim();
    if (line) return /[\/~@:]/.test(line);
    if (start < 0) break;
    end = start;
  }
  return false;
}

function stripAltScreenSpans(input: string): string {
  // Drop content between alt-screen enter (`\x1b[?1049h`) and exit (`\x1b[?1049l`).
  // Fullscreen TUIs (vim, lazygit, less) render into the alt buffer, which is
  // not the user's prompt, so anything inside that span must not match.
  let result = '';
  let cursor = 0;
  let inAlt = false;
  while (cursor < input.length) {
    if (!inAlt) {
      const next = input.indexOf('\x1b[?1049h', cursor);
      if (next === -1) {
        result += input.slice(cursor);
        break;
      }
      result += input.slice(cursor, next);
      cursor = next + 8;
      inAlt = true;
    } else {
      const next = input.indexOf('\x1b[?1049l', cursor);
      if (next === -1) return result;
      cursor = next + 8;
      inAlt = false;
    }
  }
  return result;
}

function notifyTerminalPaneStateListeners(): void {
  cachedSnapshot = null;
  listeners.forEach((listener) => listener());
}
