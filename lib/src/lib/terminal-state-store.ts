import {
  createTerminalPaneState,
  cwdFromManualPath,
  cwdFromProcessPath,
  reduceTerminalState,
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

export function setTerminalUserTitle(id: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const terminalTitle: TerminalTitle = {
    title: trimmed,
    source: 'user',
    updatedAt: Date.now(),
  };
  applyTerminalSemanticEvents(id, [{ type: 'title', title: terminalTitle }]);
}

export function seedTerminalManualCwd(id: string, path: string | null | undefined): void {
  const cwd = path ? cwdFromManualPath(path) : null;
  if (cwd && !paneStates.get(id)?.cwd) {
    ensureTerminalPaneState(id, { cwd });
  } else {
    ensureTerminalPaneState(id);
  }
}

export function fillTerminalProcessCwd(id: string, path: string | null | undefined): void {
  if (!path) return;
  const cwd = cwdFromProcessPath(path);
  if (!cwd) return;
  updateCwdIfAllowed(id, cwd);
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
  const text = stripTerminalControls(output).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1]?.trimStart() ?? '';
  if (!lastLine || lastLine.length > 200) return false;
  if (/^(?:PS\s+.+>|.+[$#%>❯λ])\s?$/.test(lastLine)) return true;
  return /^[➜❯λ]\s+.+\s$/.test(lines[lines.length - 1] ?? '');
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
