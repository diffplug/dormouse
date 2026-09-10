import { registry } from './terminal-store';
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

const paneStates = new Map<string, TerminalPaneState>();
const promptSubmitStates = new Map<string, PromptSubmitState>();
const promptShapes = new Map<string, PromptShape>();
const promptOutputBuffers = new Map<string, string>();
const promptAltScreenFilters = new Map<string, PromptAltScreenFilter>();
// Panes with authentic OSC 633/133 boundaries; the keystroke fallback stands
// down for each id here until the pane is reset or removed.
const oscDrivenPanes = new Set<string>();
const listeners = new Set<(changedId?: string) => void>();

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

/** `changedId` names the one pane whose state moved; omitting it means a
 *  store-wide change every listener must take. */
export function subscribeToTerminalPaneState(listener: (changedId?: string) => void): () => void {
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
  return countRunningSessionsIn(null);
}

/** The same count restricted to `ids` — the Workspace close confirmation asks it
 *  of one Workspace's member Surfaces (`docs/specs/layout.md` → "Workspaces").
 *  `null` means every Session in the Window. */
export function countRunningSessionsIn(ids: Iterable<string> | null): number {
  const scope = ids === null ? null : new Set(ids);
  let count = 0;
  for (const [id, state] of paneStates) {
    if (scope && !scope.has(id)) continue;
    const entry = registry.get(id);
    if (state.activity.kind === 'running' || (entry?.helper && !entry.exited && entry.helperBusy !== false)) count++;
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
  notifyTerminalPaneStateListeners(id);
  return next;
}

/** Drops every per-pane scratch map keyed by `id`; `paneStates` is the caller's
 * to set or delete. Add new per-pane state here, not at the two call sites. */
function clearPaneScratch(id: string): void {
  promptSubmitStates.delete(id);
  promptShapes.delete(id);
  promptOutputBuffers.delete(id);
  promptAltScreenFilters.delete(id);
  oscDrivenPanes.delete(id);
}

export function resetTerminalPaneState(id: string, initial?: Partial<TerminalPaneState>): void {
  clearPaneScratch(id);
  paneStates.set(id, createTerminalPaneState(initial));
  notifyTerminalPaneStateListeners(id);
}

export function removeTerminalPaneState(id: string): void {
  clearPaneScratch(id);
  if (!paneStates.delete(id)) return;
  notifyTerminalPaneStateListeners(id);
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
  notifyTerminalPaneStateListeners(id);
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

/**
 * Records a chunk of a pane's output for the keystroke prompt heuristic.
 * **Takes `TerminalProtocolParseResult.textData`, not the raw chunk** — the
 * parser has already dropped string-control payloads, so a chunked inline image
 * can never reach the 1,024-character prompt window
 * (`docs/specs/terminal-state.md`).
 */
export function recordTerminalOutput(id: string, output: string): void {
  if (!output) return;

  let filter = promptAltScreenFilters.get(id);
  if (!filter) {
    filter = new PromptAltScreenFilter();
    promptAltScreenFilters.set(id, filter);
  }
  const visible = filter.process(output);
  if (!visible) return;
  const buffer = `${promptOutputBuffers.get(id) ?? ''}${visible}`.slice(-1024);
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
  const filter = new PromptAltScreenFilter();
  const visible = filter.process(text);
  promptAltScreenFilters.set(id, filter);
  const promptLine = detectReturnedShellPrompt(visible.slice(-1024));
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
  notifyTerminalPaneStateListeners(id);
}

export function fillTerminalProcessCwd(id: string, path: string | null | undefined): void {
  if (!path) return;
  const cwd = cwdFromProcessPath(path);
  if (!cwd) return;
  updateCwdIfAllowed(id, cwd);
}

function updateCwdIfAllowed(id: string, cwd: CwdState): void {
  const current = paneStates.get(id);
  if (!current) return;
  if (!processCwdMayReplace(current.cwd?.source)) return;
  paneStates.set(id, { ...current, cwd });
  notifyTerminalPaneStateListeners(id);
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
function detectReturnedShellPrompt(visible: string): string | null {
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

// Sticky so the ground-state jump costs no copy of the chunk tail.
const ALT_GROUND_SCAN = /[\x1b\x9b]/g;

// Elide alternate-buffer output before truncating the prompt window. Keep mode
// state across chunks and command boundaries: neither can imply a buffer switch.
// CSI parameters are accumulated numerically with a cap, so arbitrary-length
// incomplete controls never retain arbitrary amounts of PTY output. Ordinary
// controls remain available to the presentation stripper's boundary handling.
class PromptAltScreenFilter {
  private inAlt = false;
  private state: 'ground' | 'escape' | 'csiStart' | 'parameters' | 'ignore' = 'ground';
  private parameter = 0;
  private hasAltParameter = false;

  process(input: string): string {
    let output = '';
    let cursor = 0;
    // Start of an unflushed verbatim run, or -1 while output is suppressed.
    // Emitting by slice rather than per character keeps an escape-dense chunk
    // from costing a string concat per byte.
    let runStart = -1;
    while (cursor < input.length) {
      if (this.state === 'ground') {
        ALT_GROUND_SCAN.lastIndex = cursor;
        const introducer = ALT_GROUND_SCAN.exec(input);
        const end = introducer ? introducer.index : input.length;
        if (!this.inAlt && runStart < 0) runStart = cursor;
        cursor = end;
        if (cursor === input.length) break;
      }
      const code = input.charCodeAt(cursor);
      if (this.inAlt) {
        if (runStart >= 0) { output += input.slice(runStart, cursor); runStart = -1; }
      } else if (runStart < 0) {
        runStart = cursor;
      }
      cursor++;
      if (code === 0x1b) {
        this.state = 'escape';
      } else if (code === 0x9b || (this.state === 'escape' && code === 0x5b /* [ */)) {
        this.state = 'csiStart';
        this.parameter = 0;
        this.hasAltParameter = false;
      } else if (this.state === 'csiStart' && code === 0x3f /* ? */) {
        this.state = 'parameters';
      } else if (this.state === 'parameters' && code >= 0x30 && code <= 0x39 /* 0-9 */) {
        this.parameter = Math.min(1050, this.parameter * 10 + (code - 0x30));
      } else if (this.state === 'parameters' && (code === 0x3b /* ; */ || code === 0x68 /* h */ || code === 0x6c /* l */)) {
        this.hasAltParameter ||= this.parameter === 47 || this.parameter === 1047 || this.parameter === 1049;
        this.parameter = 0;
        if (code !== 0x3b) {
          if (this.hasAltParameter) {
            this.inAlt = code === 0x68;
            // Separate normal-buffer regions across a screen switch, and avoid
            // retaining a partial CSI from an enter split over output chunks.
            if (runStart >= 0) { output += input.slice(runStart, cursor); runStart = -1; }
            output += '\n';
          }
          this.state = 'ground';
        }
      } else if (this.state === 'escape' && code === 0x63 /* c */) {
        this.inAlt = false;
        this.state = 'ground';
        if (runStart >= 0) { output += input.slice(runStart, cursor); runStart = -1; }
        output += '\n';
      } else if (this.state === 'escape' || (code >= 0x40 && code <= 0x7e) || code === 0x18 || code === 0x1a) {
        this.state = 'ground';
      } else {
        this.state = 'ignore';
      }
    }
    if (runStart >= 0) output += input.slice(runStart, cursor);
    return output;
  }
}

function notifyTerminalPaneStateListeners(changedId?: string): void {
  cachedSnapshot = null;
  listeners.forEach((listener) => listener(changedId));
}
