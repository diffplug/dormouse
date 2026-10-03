import type { TerminalWebglRenderer } from './terminal-webgl';
import type { SerializeAddon } from '@xterm/addon-serialize';
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
  isReplaying: boolean;
  untouched: boolean;
  /** Renderer ownership follows mount/unmount rather than terminal lifetime. */
  webglRenderer?: TerminalWebglRenderer;
  /** Reads the buffer back as the escape stream that rebuilds it, for a
   *  transfer (`serializeTerminal`). Loaded at create: it costs nothing idle. */
  serialize: SerializeAddon;
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
  /** The terminal element's box in viewport (fixed-position) coordinates;
   *  `gridLeft` / `gridTop` are relative to its corner. */
  elementLeft: number;
  elementTop: number;
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

/** Whether a helper Session may hold running work: anything short of the
 *  host's answer that it is idle, unless it has exited. */
export function helperMayBeBusy(entry: TerminalEntry): boolean {
  return !entry.exited && entry.helperBusy !== false;
}

/** Human input reached this Session: it is no longer `untouched`, which is
 *  what lets a close skip its confirmation (`docs/specs/layout.md` → "Kill
 *  confirmation"). Here, beside the registry, so a host adapter can call it
 *  without the terminal lifecycle. */
export function markSessionTouched(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  entry.inputVersion = (entry.inputVersion ?? 0) + 1;
  entry.untouched = false;
  if (entry.helper) entry.helperBusy = undefined;
}
/** Helper Sessions are private to their source: excluded from alerts, public `dor` targets, remote projections, and cross-pane derivations. */
export const isHelperSession = (id: string): boolean => !!registry.get(id)?.helper;
export const pendingShellOpts = new Map<string, PendingShellOpts>();

