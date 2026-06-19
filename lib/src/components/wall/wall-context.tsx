import { createContext } from 'react';
import type { AlertButtonActionResult, SessionStatus, SetTerminalUserTitleResult } from '../../lib/terminal-registry';
import type { WallMode, SpawnDirection } from './wall-types';
import type { RenderMode } from './agent-browser-screen';

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
  /** Swap a surface's render backend in place, preserving the target URL
   *  (docs/specs/dor-browser.md → "Render-mode transitions"). agent-browser ↔ iframe is a
   *  surface-type replacement; screencast ↔ popout is handled inside the
   *  agent-browser panel and does not route here. */
  onSwapRenderMode: (id: string, mode: RenderMode) => void;
  /** Open a URL as a new iframe browser pane, split next to `id`. The iframe
   *  renderer is single-frame, so a page's new-tab request (target=_blank /
   *  window.open, surfaced by the proxy shim) becomes a new pane
   *  (docs/specs/dor-browser.md → "New tab → new pane"). */
  onOpenBrowserPane?: (id: string, url: string) => void;
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
  onSwapRenderMode: () => {},
  onOpenBrowserPane: () => {},
});

export const RenamingIdContext = createContext<string | null>(null);
export const ZoomedContext = createContext(false);
export const WindowFocusedContext = createContext(true);

export const DialogKeyboardContext = createContext<(active: boolean) => void>(() => {});
export const FreshlySpawnedContext = createContext<Map<string, SpawnDirection>>(new Map());
