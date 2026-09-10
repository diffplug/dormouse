import type { TerminalWebglRenderer } from './terminal-webgl';
import type { HelperIdentity } from './terminal-context-types';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ShellCommandKind } from 'dor/commands/shell-quote';

export interface TerminalEntry {
  helper?: HelperIdentity;
  helperBusy?: boolean;
  inputVersion?: number;
  /** Parser family of the shell this Session launched. Unlike the app-global
   *  default, this remains stable when the user selects a different shell for
   *  future Sessions. */
  shellKind: ShellCommandKind;
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  cleanup: () => void;
  /** Replace the text snapshot the render handler compares a finalized Dormouse
   *  selection against; `null` stops it watching. */
  setSelectionBaseline: (baseline: string | null) => void;
  isReplaying: boolean;
  untouched: boolean;
  /** Renderer ownership follows mount/unmount rather than terminal lifetime. */
  webglRenderer?: TerminalWebglRenderer;
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
  helper?: HelperIdentity;
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
/** Helper Sessions are private to their source: excluded from alerts, `dor`, remote projections, and cross-pane derivations. */
export const isHelperSession = (id: string): boolean => !!registry.get(id)?.helper;
export const pendingShellOpts = new Map<string, PendingShellOpts>();
/** Arm render-tick invalidation for a selection some other module just set, so
 *  it is dropped when the text under it changes (a pin's restored range). */
export function setTerminalSelectionBaseline(id: string, baseline: string | null): void {
  registry.get(id)?.setSelectionBaseline(baseline);
}
