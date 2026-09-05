import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ShellCommandKind } from 'dor/commands/shell-quote';

export interface TerminalEntry {
  /** Parser family of the shell this Session launched. Unlike the app-global
   *  default, this remains stable when the user selects a different shell for
   *  future Sessions. */
  shellKind: ShellCommandKind;
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  cleanup: () => void;
  isReplaying: boolean;
  untouched: boolean;
  /**
   * Whether the WebGL renderer has been offered to this terminal yet. Set on
   * first mount, never cleared — a terminal that fell back to xterm's DOM
   * renderer stays there for its lifetime (`docs/specs/layout.md` → Renderer).
   */
  webglAttempted?: boolean;
  /**
   * The PTY process has exited (onPtyExit fired or resume restored it as
   * exited) but the pane lingers in the registry showing "[Process exited…]".
   * The directory reports this surface as `alive: false` so the phone's picker
   * stops offering it as attachable.
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
