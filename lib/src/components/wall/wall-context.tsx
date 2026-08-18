import { createContext } from 'react';
import type { AlertButtonActionResult, SessionStatus, SetTerminalUserTitleResult } from '../../lib/terminal-registry';
import type { WallMode } from './wall-types';
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
   *  (docs/specs/dor-browser.md → "Display Modal And Render Swaps"). agent-browser ↔ iframe is a
   *  surface-type replacement; screencast ↔ popout is handled inside the
   *  agent-browser panel and does not route here. */
  onSwapRenderMode: (id: string, mode: RenderMode) => void;
  /** Open a URL as a new iframe browser pane, split next to `id`. The iframe
   *  renderer is single-frame, so a page's new-tab request (target=_blank /
   *  window.open, surfaced by the proxy shim) becomes a new pane
   *  (docs/specs/dor-browser.md → "Iframe Shim"). */
  onOpenBrowserPane?: (id: string, url: string) => void;
  /** The stable `surface:N` ref for a pane/door id (minted lazily, exactly as
   *  `dor list` assigns refs). Used by the pane context menu to show the handle. */
  resolveSurfaceRef: (id: string) => string;
  /** Act like `dor ab open <url>` for a port the pane's process tree binds: create
   *  the default agent-browser surface immediately, then open the URL on its
   *  session and connect the pane (`connect-port.ts`). Fire-and-forget — failures
   *  are logged, and the pane itself shows loading state. */
  onConnectPort: (id: string, url: string) => void;
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
  resolveSurfaceRef: (id: string) => id,
  onConnectPort: () => {},
});

/** Engine-directed writes from a pane/header (title + params). The read side is
 *  the plain `PaneProps`; writes go here because they target the tiling engine,
 *  which owns the per-leaf metadata (docs/specs/tiling-engine.md → "Pane props
 *  contract"). Wall.tsx provides the engine-backed implementation; the default is a
 *  no-op so a component renders standalone (tests, Storybook) without a provider. */
export interface PaneWriteActions {
  setTitle(id: string, title: string): void;
  updateParams(id: string, patch: Record<string, unknown>): void;
}

export const PaneWriteContext = createContext<PaneWriteActions>({
  setTitle: () => {},
  updateParams: () => {},
});

export const RenamingIdContext = createContext<string | null>(null);
/** Exact zoom owner for pane-local chrome. Pane chrome compares against its own id
 * rather than reading a boolean, so a partially exposed pane does not render
 * another pane's Unzoom state. */
export const ZoomedIdContext = createContext<string | null>(null);
export const WindowFocusedContext = createContext(true);

export const DialogKeyboardContext = createContext<(active: boolean) => void>(() => {});
