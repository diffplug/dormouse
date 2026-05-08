import {
  createTerminalPaneState,
  cwdFromManualPath,
  cwdFromProcessPath,
  DEFAULT_IDLE_TITLE,
  reduceTerminalState,
  UNNAMED_PANEL_TITLE,
  type CwdState,
  type TerminalPaneState,
  type TerminalSemanticEvent,
  type TerminalTitle,
} from './terminal-state';
import {
  createPromptCommandInputState,
  updatePromptCommandInput,
  type PromptCommandInputState,
} from './terminal-command-input';
import { getSessionIdByPtyId } from './terminal-store';

const paneStates = new Map<string, TerminalPaneState>();
const promptInputStates = new Map<string, PromptCommandInputState>();
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
  promptInputStates.delete(id);
  promptOutputBuffers.delete(id);
  paneStates.set(id, createTerminalPaneState(initial));
  notifyTerminalPaneStateListeners();
}

export function removeTerminalPaneState(id: string): void {
  promptInputStates.delete(id);
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
    promptInputStates.delete(id);
    promptOutputBuffers.delete(id);
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

export function recordTerminalUserInput(id: string, input: string): void {
  if (!input) return;
  const state = paneStates.get(id) ?? createTerminalPaneState();
  if (state.currentCommand || state.activity.kind === 'running' || state.activity.kind === 'finished') return;

  const promptInputState = promptInputStates.get(id) ?? createPromptCommandInputState();
  const next = updatePromptCommandInput(promptInputState, input);
  promptInputStates.set(id, next.state);

  if (next.submittedCommandLine) {
    applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: next.submittedCommandLine },
      { type: 'commandStart', source: 'user_input' },
    ]);
  }
}

export function recordTerminalUserInputByPtyId(ptyId: string, input: string): void {
  recordTerminalUserInput(resolvePaneStateIdByPtyId(ptyId), input);
}

export function recordTerminalOutput(id: string, output: string): void {
  if (!output) return;
  const state = paneStates.get(id);
  if (state?.currentCommand?.source !== 'user_input') return;

  const buffer = `${promptOutputBuffers.get(id) ?? ''}${output}`.slice(-1024);
  promptOutputBuffers.set(id, buffer);
  if (!looksLikeReturnedShellPrompt(buffer)) return;

  promptOutputBuffers.delete(id);
  applyTerminalSemanticEvents(id, [{ type: 'promptStart' }, { type: 'promptEnd' }]);
}

export function recordTerminalOutputByPtyId(ptyId: string, output: string): void {
  recordTerminalOutput(resolvePaneStateIdByPtyId(ptyId), output);
}

const RESERVED_USER_TITLES = new Set<string>([DEFAULT_IDLE_TITLE, UNNAMED_PANEL_TITLE]);

export function setTerminalUserTitle(id: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed || RESERVED_USER_TITLES.has(trimmed)) return;
  const terminalTitle: TerminalTitle = {
    title: trimmed,
    source: 'user',
    updatedAt: Date.now(),
  };
  applyTerminalSemanticEvents(id, [{ type: 'title', title: terminalTitle }]);
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
  const inputA = promptInputStates.get(idA);
  const inputB = promptInputStates.get(idB);
  const outputA = promptOutputBuffers.get(idA);
  const outputB = promptOutputBuffers.get(idB);
  if (!stateA && !stateB && !inputA && !inputB && !outputA && !outputB) return;
  if (stateB) paneStates.set(idA, stateB);
  else paneStates.delete(idA);
  if (stateA) paneStates.set(idB, stateA);
  else paneStates.delete(idB);
  if (inputB) promptInputStates.set(idA, inputB);
  else promptInputStates.delete(idA);
  if (inputA) promptInputStates.set(idB, inputA);
  else promptInputStates.delete(idB);
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

function looksLikeReturnedShellPrompt(output: string): boolean {
  const visible = stripAltScreenSpans(output);
  const text = stripTerminalControls(visible).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Real prompts come on a fresh line. Requiring a leading newline rejects
  // arbitrary command output that happens to end with a prompt-like character.
  const newlineIndex = text.lastIndexOf('\n');
  if (newlineIndex === -1) return false;
  const lastLine = text.slice(newlineIndex + 1).trimStart();
  if (lastLine.length < 3 || lastLine.length > 200) return false;
  // PowerShell `PS C:\path>` (with optional trailing space).
  if (/^PS\s+\S.*>\s?$/.test(lastLine)) return true;
  // Arrow-style prompts (oh-my-zsh, starship, fish defaults).
  if (/^[➜❯λ]\s+\S/.test(lastLine) && lastLine.endsWith(' ')) return true;
  // Generic shell prompts: require a path/user context signal AND a trailing
  // prompt char + space. The context check rejects lines like "step 1: done"
  // or "loading 95% complete" that happen to end in a punctuation mark.
  if (!/[\/~@:]/.test(lastLine)) return false;
  return /[$#%>]\s$/.test(lastLine);
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
