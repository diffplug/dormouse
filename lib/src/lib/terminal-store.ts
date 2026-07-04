import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SessionStatus } from './activity-monitor';
import type { ActivityNotification, TodoState } from './alert-manager';

export interface ActivityState {
  status: SessionStatus;
  watchingEnabled: boolean;
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
  watchingEnabled: boolean;
  todo: TodoState;
  notification: ActivityNotification | null;
  attentionDismissedRing: boolean;
  isReplaying: boolean;
  untouched: boolean;
  /**
   * The PTY process has exited (onPtyExit fired) but the pane lingers in the
   * registry showing "[Process exited…]". The directory reports this surface as
   * `alive: false` so the phone's picker stops offering it as attachable.
   */
  exited?: boolean;
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

export interface PendingShellOpts {
  shell?: string;
  args?: string[];
  cwd?: string;
  title?: string;
  untouched?: boolean;
  /** Raw command string typed into the spawned interactive shell once it reaches a prompt; seeded as the pane's command run. */
  command?: string;
  /**
   * `dor ensure` surface: the command must only be typed once OSC 633 shell
   * integration is confirmed, and dropped (never typed) otherwise — so a shell
   * with no integration (e.g. cmd.exe) can't half-run an untrackable command.
   * `dor split` leaves this unset and types best-effort into any shell.
   */
  requireIntegration?: boolean;
}

export const registry = new Map<string, TerminalEntry>();
export const pendingShellOpts = new Map<string, PendingShellOpts>();

export function getEntryByPtyId(ptyId: string): TerminalEntry | null {
  for (const entry of registry.values()) {
    if (entry.ptyId === ptyId) {
      return entry;
    }
  }
  return null;
}

export function getSessionIdByPtyId(ptyId: string): string | null {
  for (const [id, entry] of registry) {
    if (entry.ptyId === ptyId) return id;
  }
  return null;
}

export function resolveTerminalSessionId(id: string): string {
  return registry.get(id)?.ptyId ?? id;
}
