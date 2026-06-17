import { createContext } from 'react';
import type { AlertButtonActionResult, SessionStatus, SetTerminalUserTitleResult } from '../../lib/terminal-registry';
import type { WallMode, SpawnDirection } from './wall-types';

export interface PaneElementsState {
  elements: Map<string, HTMLElement>;
  version: number;
  bumpVersion: () => void;
}

export const ModeContext = createContext<WallMode>('command');
export const SelectedIdContext = createContext<string | null>(null);

export const PaneElementsContext = createContext<PaneElementsState>({
  elements: new Map(),
  version: 0,
  bumpVersion: () => {},
});

export const DoorElementsContext = createContext<PaneElementsState>({
  elements: new Map(),
  version: 0,
  bumpVersion: () => {},
});

export interface WallActions {
  onKill: (id: string) => void;
  onMinimize: (id: string) => void;
  onAlertButton: (id: string, displayedStatus: SessionStatus) => AlertButtonActionResult;
  onToggleTodo: (id: string) => void;
  onSplitH: (id: string | null, source?: 'keyboard' | 'mouse') => void;
  onSplitV: (id: string | null, source?: 'keyboard' | 'mouse') => void;
  onZoom: (id: string) => void;
  onClickPanel: (id: string) => void;
  /** Jump to/focus an arbitrary pane by id (visible or minimized). Used by the
   *  browser header's dev-server chip to surface the terminal serving a port. */
  onFocusPane: (id: string) => void;
  onStartRename: (id: string) => void;
  onFinishRename: (id: string, value: string) => SetTerminalUserTitleResult;
  onCancelRename: () => void;
}

export const WallActionsContext = createContext<WallActions>({
  onKill: () => {},
  onMinimize: () => {},
  onAlertButton: () => 'noop',
  onToggleTodo: () => {},
  onSplitH: () => {},
  onSplitV: () => {},
  onZoom: () => {},
  onClickPanel: () => {},
  onFocusPane: () => {},
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
});

export const RenamingIdContext = createContext<string | null>(null);
export const ZoomedContext = createContext(false);
export const WindowFocusedContext = createContext(true);

export const DialogKeyboardContext = createContext<(active: boolean) => void>(() => {});
export const FreshlySpawnedContext = createContext<Map<string, SpawnDirection>>(new Map());
