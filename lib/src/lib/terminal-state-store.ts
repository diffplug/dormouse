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
import { getSessionIdByPtyId } from './terminal-store';

const paneStates = new Map<string, TerminalPaneState>();
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
  paneStates.set(id, createTerminalPaneState(initial));
  notifyTerminalPaneStateListeners();
}

export function removeTerminalPaneState(id: string): void {
  if (!paneStates.delete(id)) return;
  notifyTerminalPaneStateListeners();
}

export function applyTerminalSemanticEventsByPtyId(ptyId: string, events: TerminalSemanticEvent[]): void {
  const id = resolvePaneStateIdByPtyId(ptyId);
  applyTerminalSemanticEvents(id, events);
}

export function applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
  if (events.length === 0) return;
  const prev = paneStates.get(id) ?? createTerminalPaneState();
  let next = prev;
  for (const event of events) {
    next = reduceTerminalState(next, event);
  }
  if (next === prev && paneStates.has(id)) return;
  paneStates.set(id, next);
  notifyTerminalPaneStateListeners();
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
  if (!stateA && !stateB) return;
  if (stateB) paneStates.set(idA, stateB);
  else paneStates.delete(idA);
  if (stateA) paneStates.set(idB, stateA);
  else paneStates.delete(idB);
  notifyTerminalPaneStateListeners();
}

function updateCwdIfAllowed(id: string, cwd: CwdState): void {
  const current = paneStates.get(id) ?? createTerminalPaneState();
  const currentSource = current.cwd?.source;
  if (currentSource && currentSource !== 'manual' && currentSource !== 'process') return;
  paneStates.set(id, { ...current, cwd });
  notifyTerminalPaneStateListeners();
}

function resolvePaneStateIdByPtyId(ptyId: string): string {
  return getSessionIdByPtyId(ptyId) ?? ptyId;
}

function notifyTerminalPaneStateListeners(): void {
  cachedSnapshot = null;
  listeners.forEach((listener) => listener());
}
