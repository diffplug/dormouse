import {
  createTerminalPaneState,
  cwdFromManualPath,
  cwdFromProcessPath,
  DEFAULT_IDLE_TITLE,
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
import { getSessionIdByPtyId } from './terminal-store';

const paneStates = new Map<string, TerminalPaneState>();
const promptSubmitStates = new Map<string, PromptSubmitState>();
const promptShapes = new Map<string, PromptShape>();
const promptOutputBuffers = new Map<string, string>();
const listeners = new Set<() => void>();
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

export function ensureTerminalPaneState(id: string, initial?: Partial<TerminalPaneState>): TerminalPaneState {
  const existing = paneStates.get(id);
  if (existing) return existing;
  const next = createTerminalPaneState(initial);
  paneStates.set(id, next);
  notifyTerminalPaneStateListeners();
  return next;
}

export function resetTerminalPaneState(id: string, initial?: Partial<TerminalPaneState>): void {
  promptSubmitStates.delete(id);
  promptShapes.delete(id);
  promptOutputBuffers.delete(id);
  paneStates.set(id, createTerminalPaneState(initial));
  notifyTerminalPaneStateListeners();
}

export function removeTerminalPaneState(id: string): void {
  promptSubmitStates.delete(id);
  promptShapes.delete(id);
  promptOutputBuffers.delete(id);
  if (!paneStates.delete(id)) return;
  notifyTerminalPaneStateListeners();
}

export function applyTerminalSemanticEventsByPtyId(ptyId: string, events: TerminalSemanticEvent[]): void {
  const id = resolvePaneStateIdByPtyId(ptyId);
  applyTerminalSemanticEvents(id, events);
}

export function applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
  if (events.length === 0) return;
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
    applyTerminalSemanticEvents(id, [{ type: 'promptStart' }, { type: 'promptEnd' }]);
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
  const promptLine = detectReturnedShellPrompt(scrollback.slice(-1024));
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

export function swapTerminalPaneStates(idA: string, idB: string): void {
  const stateA = paneStates.get(idA);
  const stateB = paneStates.get(idB);
  const inputA = promptSubmitStates.get(idA);
  const inputB = promptSubmitStates.get(idB);
  const shapeA = promptShapes.get(idA);
  const shapeB = promptShapes.get(idB);
  const outputA = promptOutputBuffers.get(idA);
  const outputB = promptOutputBuffers.get(idB);
  if (!stateA && !stateB && !inputA && !inputB && !shapeA && !shapeB && !outputA && !outputB) return;
  if (stateB) paneStates.set(idA, stateB);
  else paneStates.delete(idA);
  if (stateA) paneStates.set(idB, stateA);
  else paneStates.delete(idB);
  if (inputB) promptSubmitStates.set(idA, inputB);
  else promptSubmitStates.delete(idA);
  if (inputA) promptSubmitStates.set(idB, inputA);
  else promptSubmitStates.delete(idB);
  if (shapeB) promptShapes.set(idA, shapeB);
  else promptShapes.delete(idA);
  if (shapeA) promptShapes.set(idB, shapeA);
  else promptShapes.delete(idB);
  if (outputB) promptOutputBuffers.set(idA, outputB);
  else promptOutputBuffers.delete(idA);
  if (outputA) promptOutputBuffers.set(idB, outputA);
  else promptOutputBuffers.delete(idB);
  notifyTerminalPaneStateListeners();
}

function updateCwdIfAllowed(id: string, cwd: CwdState): void {
  const current = paneStates.get(id);
  if (!current) return;
  const currentSource = current.cwd?.source;
  if (currentSource && currentSource !== 'manual' && currentSource !== 'process') return;
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
// false positives would prematurely flip a running command back to idle.
function detectReturnedShellPrompt(output: string): string | null {
  const visible = stripAltScreenSpans(output);
  const text = stripTerminalControls(visible).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Prompts usually come on a fresh line; that rejects arbitrary command output
  // that happens to end with a prompt-like character. The spawn-time first
  // prompt may be the whole buffer with no leading newline, so accept that too.
  const newlineIndex = text.lastIndexOf('\n');
  const lastLine = (newlineIndex === -1 ? text : text.slice(newlineIndex + 1)).trimStart();
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
    return precedingLineHasPromptContext(text, newlineIndex) ? lastLine : null;
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

function stripTerminalControls(input: string): string {
  return input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function notifyTerminalPaneStateListeners(): void {
  cachedSnapshot = null;
  listeners.forEach((listener) => listener());
}
