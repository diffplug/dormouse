import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ConfirmKill } from '../../KillConfirm';
import type { DoorAfterRestoreAction, DooredItem, WallEvent, WallMode, WallSelectionKind } from '../wall-types';
import type { WallActions } from '../wall-context';

/** The navigation/query seam the keyboard handlers read, backed by the Lath engine
 *  (docs/specs/tiling-engine.md). */
export interface WallNav {
  /** Nearest pane id in the arrow's direction, or null. */
  findInDirection(id: string, dir: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): string | null;
  /** A visible pane's params (surface-type classification), or undefined. */
  paneParams(id: string): Record<string, unknown> | undefined;
  /** Whether `id` is a live visible pane. */
  hasPane(id: string): boolean;
  /** Visible pane ids in order (Lath: pre-order leaves). */
  panes(): string[];
}

/** Refs + callbacks shared by every keyboard branch. Bundled to avoid 25-arg
 *  signatures on each handler. */
export interface WallKeyboardCtx {
  nav: WallNav;
  /** Swap two panes' surfaces (Cmd-Arrow): swap leaf identities (meta follows ids,
   *  so no companion title swap). */
  swapWithNeighbor: (fromId: string, toId: string) => void;
  modeRef: RefObject<WallMode>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
  doorsRef: RefObject<DooredItem[]>;
  confirmKillRef: RefObject<ConfirmKill | null>;
  renamingRef: RefObject<string | null>;
  dialogKeyboardActiveRef: RefObject<boolean>;
  wallActionsRef: RefObject<WallActions>;
  handleReattachRef: RefObject<(item: DooredItem, options?: { enterPassthrough?: boolean; afterRestore?: DoorAfterRestoreAction }) => void>;
  selectPane: (id: string) => void;
  selectDoor: (id: string) => void;
  enterTerminalMode: (id: string) => void;
  exitTerminalMode: () => void;
  minimizePane: (id: string) => void;
  killPaneImmediately: (id: string) => void;
  acceptKill: () => void;
  rejectKill: () => void;
  setConfirmKill: Dispatch<SetStateAction<ConfirmKill | null>>;
  setRenamingPaneId: Dispatch<SetStateAction<string | null>>;
  fireEvent: (event: WallEvent) => void;
}

/** Per-press dual-tap state — left-Meta then right-Meta within 500ms exits
 *  passthrough mode. Same for Shift. */
export interface DualTapState {
  lastCmdSide: RefObject<'left' | 'right' | null>;
  lastCmdTime: RefObject<number>;
  lastShiftSide: RefObject<'left' | 'right' | null>;
  lastShiftTime: RefObject<number>;
}

/** Last arrow direction, so the inverse arrow can return to the prior pane. */
export interface NavHistoryRef {
  current: { direction: string; fromId: string } | null;
}

export const ARROW_OPPOSITES = {
  ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft',
  ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp',
} as const;

export type ArrowKey = keyof typeof ARROW_OPPOSITES;

export function isArrowKey(key: string): key is ArrowKey {
  return key in ARROW_OPPOSITES;
}
