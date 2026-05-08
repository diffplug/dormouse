import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SessionStatus } from './activity-monitor';
import type { ActivityNotification, TodoState } from './alert-manager';

export interface ActivityState {
  status: SessionStatus;
  todo: TodoState;
  notification: ActivityNotification | null;
}

export interface TerminalEntry {
  ptyId: string;
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  cleanup: () => void;
  alertStatus: SessionStatus;
  todo: TodoState;
  notification: ActivityNotification | null;
  attentionDismissedRing: boolean;
  isReplaying: boolean;
}

export interface TerminalOverlayDims {
  cols: number;
  rows: number;
  viewportY: number;
  baseY: number;
  elementWidth: number;
  elementHeight: number;
  cellWidth: number;
  cellHeight: number;
  gridLeft: number;
  gridTop: number;
}

export const registry = new Map<string, TerminalEntry>();
export const pendingShellOpts = new Map<string, { shell?: string; args?: string[] }>();

export function getEntryByPtyId(ptyId: string): TerminalEntry | null {
  for (const entry of registry.values()) {
    if (entry.ptyId === ptyId) {
      return entry;
    }
  }
  return null;
}

export function resolveTerminalSessionId(id: string): string {
  return registry.get(id)?.ptyId ?? id;
}
